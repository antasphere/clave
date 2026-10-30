/**
 * The phone's client of a Clave server's push channel: one WebSocket on
 * `/push`, the token in the first frame, the sessions subscribed on behalf
 * of its listeners, the socket reopened with a jittered backoff when it
 * drops and every subscription asked again, so a screen that was listening
 * keeps listening without knowing the socket changed. A refusal of the
 * token is final.
 *
 * Ported from the desktop's `packages/client/src/push-client.ts` (the
 * protocol and the reconnect are the same), with two differences the phone
 * needs: a client-side liveness ping (a phone's socket dies silently when
 * the network changes under it; the server answers `pong`, and a socket that
 * answers nothing within the deadline is closed and reopened), and frames
 * this client does not know are ignored rather than reported.
 */
import { parseServerFrame } from '../contract/decode'
import { assertCredentialMayTravelTo, type BuildKind } from '../machines/transport-policy'
import {
  CLOSE_UNAUTHORIZED,
  PUSH_PATH,
  type ClientFrame,
  type ServerEventEnvelope,
  type Session,
  type SessionStream
} from '../contract/types'

export type PushStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface PushStatusDetail {
  readonly code?: number
  readonly reason?: string
  readonly final?: 'unauthorized' | 'closed'
  readonly attempt?: number
}

/** The subset of the WebSocket API the client uses, so a test hands it `ws`. */
export interface PushSocketLike {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
export type PushSocketConstructor = new (url: string) => PushSocketLike

export interface Timers {
  readonly setTimeout: (fn: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export interface PushClientOptions {
  /** The server's base URL (`http://127.0.0.1:43201`) or its push URL. */
  readonly url: string
  readonly token: string
  readonly WebSocket?: PushSocketConstructor
  readonly client?: string
  readonly backoff?: { readonly baseMs?: number; readonly maxMs?: number }
  /** The liveness ping: every `intervalMs` once open (20 s), a socket that
   *  sends nothing back within `timeoutMs` (10 s) is closed and reopened. */
  readonly liveness?: { readonly intervalMs?: number; readonly timeoutMs?: number }
  readonly timers?: Timers
  readonly random?: () => number
  /** Which build this is (`transport-policy.ts`); release by default. */
  readonly build?: BuildKind
}

export type Unsubscribe = () => void

interface Subscription {
  readonly streams: Set<(stream: SessionStream) => void>
  readonly exits: Set<(code: number) => void>
  ended: boolean
  acked: Session | null
  waiters: Array<{ resolve: (session: Session) => void; reject: (error: Error) => void }>
}

export const pushUrlOf = (url: string): string => {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:'
  if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = PUSH_PATH
  else if (!parsed.pathname.endsWith(PUSH_PATH))
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}${PUSH_PATH}`
  return parsed.toString()
}

/** The close code this client uses when the liveness deadline passes. */
export const CLOSE_LIVENESS = 4000

const textOf = (data: unknown): string =>
  typeof data === 'string'
    ? data
    : data instanceof ArrayBuffer
      ? new TextDecoder().decode(data)
      : ArrayBuffer.isView(data)
        ? new TextDecoder().decode(data)
        : String(data)

const defaultSocket = (): PushSocketConstructor => {
  const ctor = (globalThis as { WebSocket?: PushSocketConstructor }).WebSocket
  if (!ctor) throw new Error('No WebSocket in this environment: pass one in the options')
  return ctor
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export class ClavePushClient {
  private socket: PushSocketLike | null = null
  private status_: PushStatus = 'idle'
  private attempts = 0
  private timer: unknown = null
  private pingTimer: unknown = null
  private pongTimer: unknown = null
  private stopped = false
  private readonly url: string
  private readonly timers: Timers
  private readonly random: () => number
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly eventListeners = new Set<(envelope: ServerEventEnvelope) => void>()
  private readonly statusListeners = new Set<
    (status: PushStatus, detail: PushStatusDetail) => void
  >()
  private readonly errorListeners = new Set<(message: string, sessionId?: string) => void>()
  private openWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  /** How many times the socket was opened, hello sent; a reconnection adds one. */
  connections = 0
  /** How many pings went out, for the record and the tests. */
  pings = 0
  /** The server named in the last welcome, null before one. */
  serverId: string | null = null
  serverVersion: string | null = null

  constructor(private readonly options: PushClientOptions) {
    this.url = pushUrlOf(options.url)
    assertCredentialMayTravelTo(this.url, options.build ?? 'release')
    this.timers = options.timers ?? defaultTimers
    this.random = options.random ?? Math.random
  }

  get status(): PushStatus {
    return this.status_
  }

  connect(): this {
    if (this.stopped) throw new Error('This push client was closed')
    if (this.socket) return this
    this.open(this.status_ === 'idle' ? 'connecting' : 'reconnecting')
    return this
  }

  whenOpen(): Promise<void> {
    if (this.status_ === 'open') return Promise.resolve()
    if (this.stopped) return Promise.reject(new Error('This push client was closed'))
    return new Promise((resolve, reject) => this.openWaiters.push({ resolve, reject }))
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    try {
      socket?.close(1000, 'client closed')
    } catch {
      /* already gone */
    }
    for (const subscription of this.subscriptions.values())
      this.failSubscribers(subscription, new Error('This push client was closed'))
    this.subscriptions.clear()
    this.setStatus('closed', { final: 'closed' })
    this.failWaiters(new Error('This push client was closed'))
  }

  subscribe(
    sessionId: string,
    onStream: (stream: SessionStream) => void,
    onExit?: (code: number) => void
  ): Unsubscribe {
    let subscription = this.subscriptions.get(sessionId)
    const fresh = !subscription || subscription.ended
    if (!subscription) {
      subscription = {
        streams: new Set(),
        exits: new Set(),
        ended: false,
        acked: null,
        waiters: []
      }
      this.subscriptions.set(sessionId, subscription)
    }
    if (fresh) subscription.acked = null
    subscription.ended = false
    subscription.streams.add(onStream)
    if (onExit) subscription.exits.add(onExit)
    if (fresh && this.status_ === 'open') this.send({ _tag: 'subscribe', sessionId })
    return () => {
      const current = this.subscriptions.get(sessionId)
      if (!current) return
      current.streams.delete(onStream)
      if (onExit) current.exits.delete(onExit)
      if (current.streams.size === 0 && current.exits.size === 0) {
        this.subscriptions.delete(sessionId)
        this.failSubscribers(current, new Error('Unsubscribed before the server answered'))
        if (this.status_ === 'open') this.send({ _tag: 'unsubscribe', sessionId })
      }
    }
  }

  /** The server's record for a subscribed session, once the `subscribed`
   *  frame has arrived; rejected with the server's refusal. */
  subscribed(sessionId: string): Promise<Session> {
    const subscription = this.subscriptions.get(sessionId)
    if (!subscription) return Promise.reject(new Error(`Not subscribed to ${sessionId}`))
    if (subscription.acked) return Promise.resolve(subscription.acked)
    if (this.stopped) return Promise.reject(new Error('This push client was closed'))
    return new Promise((resolve, reject) => subscription.waiters.push({ resolve, reject }))
  }

  onEvent(listener: (envelope: ServerEventEnvelope) => void): Unsubscribe {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onStatus(listener: (status: PushStatus, detail: PushStatusDetail) => void): Unsubscribe {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  onError(listener: (message: string, sessionId?: string) => void): Unsubscribe {
    this.errorListeners.add(listener)
    return () => {
      this.errorListeners.delete(listener)
    }
  }

  private open(status: PushStatus): void {
    const Ctor = this.options.WebSocket ?? defaultSocket()
    this.setStatus(status, { attempt: this.attempts })
    let socket: PushSocketLike
    try {
      socket = new Ctor(this.url)
    } catch (error) {
      this.scheduleReconnect(0, String(error))
      return
    }
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.connections += 1
      this.send({ _tag: 'hello', token: this.options.token, client: this.options.client })
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.receive(textOf(event.data))
    }
    socket.onerror = () => {
      /* the close that follows carries the outcome */
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearLiveness()
      if (this.stopped) return
      if (event.code === CLOSE_UNAUTHORIZED) {
        this.stopped = true
        this.setStatus('closed', { code: event.code, reason: event.reason, final: 'unauthorized' })
        this.failWaiters(new Error(`The server refused the token (${event.code} ${event.reason})`))
        return
      }
      this.scheduleReconnect(event.code, event.reason)
    }
  }

  private scheduleReconnect(code: number, reason: string): void {
    const attempt = ++this.attempts
    const base = this.options.backoff?.baseMs ?? 250
    const max = this.options.backoff?.maxMs ?? 10_000
    const delay = Math.min(max, base * 2 ** Math.min(attempt - 1, 10)) * (0.5 + this.random() * 0.5)
    this.setStatus('reconnecting', { code, reason, attempt })
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      if (!this.stopped) this.open('reconnecting')
    }, delay)
  }

  // ── liveness ──

  private armPing(): void {
    this.clearLiveness()
    const interval = this.options.liveness?.intervalMs ?? 20_000
    this.pingTimer = this.timers.setTimeout(() => {
      this.pingTimer = null
      if (this.status_ !== 'open' || !this.socket) return
      this.pings += 1
      this.send({ _tag: 'ping' })
      const timeout = this.options.liveness?.timeoutMs ?? 10_000
      this.pongTimer = this.timers.setTimeout(() => {
        this.pongTimer = null
        const socket = this.socket
        if (!socket) return
        // Nothing came back: the socket is dead under us. Closing it runs the
        // reconnect path through onclose; a platform that never fires onclose
        // for a dead socket is covered by dropping it here first.
        this.socket = null
        try {
          socket.close(CLOSE_LIVENESS, 'no pong')
        } catch {
          /* already gone */
        }
        if (!this.stopped) this.scheduleReconnect(CLOSE_LIVENESS, 'no pong')
      }, timeout)
    }, interval)
  }

  private clearLiveness(): void {
    if (this.pingTimer) this.timers.clearTimeout(this.pingTimer)
    if (this.pongTimer) this.timers.clearTimeout(this.pongTimer)
    this.pingTimer = null
    this.pongTimer = null
  }

  private clearTimers(): void {
    if (this.timer) this.timers.clearTimeout(this.timer)
    this.timer = null
    this.clearLiveness()
  }

  // ── frames ──

  private receive(text: string): void {
    const frame = parseServerFrame(text)
    if (!frame) return
    // Any frame proves the socket alive: the pong deadline is withdrawn and
    // the next ping scheduled from now.
    if (this.status_ === 'open') this.armPing()
    switch (frame._tag) {
      case 'welcome': {
        this.attempts = 0
        this.serverId = frame.serverId
        this.serverVersion = frame.version ?? null
        // Invalidate the previous socket's acknowledgements before welcome listeners
        // request a snapshot. They must await this socket's subscription barrier.
        for (const subscription of this.subscriptions.values()) subscription.acked = null
        this.setStatus('open', {})
        this.armPing()
        for (const [sessionId, subscription] of this.subscriptions)
          if (!subscription.ended) {
            subscription.acked = null
            this.send({ _tag: 'subscribe', sessionId })
          }
        const waiters = this.openWaiters
        this.openWaiters = []
        for (const waiter of waiters) waiter.resolve()
        return
      }
      case 'stream': {
        const subscription = this.subscriptions.get(frame.sessionId)
        for (const listener of subscription?.streams ?? [])
          this.safely(() => listener(frame.stream))
        return
      }
      case 'exit': {
        const subscription = this.subscriptions.get(frame.sessionId)
        if (subscription) subscription.ended = true
        for (const listener of subscription?.exits ?? []) this.safely(() => listener(frame.code))
        return
      }
      case 'event': {
        const envelope = { id: frame.id, seq: frame.seq, at: frame.at, event: frame.event }
        for (const listener of this.eventListeners) this.safely(() => listener(envelope))
        return
      }
      case 'error': {
        const subscription = frame.sessionId ? this.subscriptions.get(frame.sessionId) : undefined
        if (subscription) this.failSubscribers(subscription, new Error(frame.message))
        for (const listener of this.errorListeners) listener(frame.message, frame.sessionId)
        return
      }
      case 'subscribed': {
        const subscription = this.subscriptions.get(frame.sessionId)
        if (!subscription) return
        subscription.acked = frame.session
        const waiters = subscription.waiters.splice(0)
        for (const waiter of waiters) waiter.resolve(frame.session)
        return
      }
      case 'unsubscribed':
      case 'pong':
      case 'request':
        return
    }
  }

  private send(frame: ClientFrame): void {
    const socket = this.socket
    if (!socket) return
    try {
      socket.send(JSON.stringify(frame))
    } catch (error) {
      for (const listener of this.errorListeners) listener(`Send failed: ${String(error)}`)
    }
  }

  private setStatus(status: PushStatus, detail: PushStatusDetail): void {
    this.status_ = status
    for (const listener of this.statusListeners) this.safely(() => listener(status, detail))
  }

  private failSubscribers(subscription: Subscription, error: Error): void {
    const waiters = subscription.waiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
  }

  private failWaiters(error: Error): void {
    const waiters = this.openWaiters
    this.openWaiters = []
    for (const waiter of waiters) waiter.reject(error)
  }

  private safely(run: () => void): void {
    try {
      run()
    } catch (error) {
      console.error('[clave-mobile] push listener failed', error)
    }
  }
}
