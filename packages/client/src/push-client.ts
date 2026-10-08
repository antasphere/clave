/**
 * The push client: one WebSocket to the server's push channel, kept alive
 * across drops. It says hello with the token, subscribes to sessions on
 * behalf of its listeners, and when the socket goes it reconnects with a
 * jittered backoff and subscribes every session again, so a view that was
 * listening keeps listening without knowing the socket changed. A refusal
 * of the token is final: the client stops and says so.
 */
import {
  CLOSE_UNAUTHORIZED,
  PUSH_PATH,
  type ServerFrame,
  decodeServerFrame,
  encodeClientFrame
} from '@clave/contract/push'
import type { ServerEventEnvelope } from '@clave/contract/events'
import type { Session, SessionStream } from '@clave/contract/sessions'
import type { ViewRequest } from '@clave/contract/views'
import { Either } from 'effect'

export type PushStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface PushStatusDetail {
  readonly code?: number
  readonly reason?: string
  /** Set when the client will not try again. */
  readonly final?: 'unauthorized' | 'closed'
  readonly attempt?: number
}

/** The subset of the WebSocket API the client uses, so a test can hand it `ws`. */
export interface PushSocketLike {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly readyState: number
}
export type PushSocketConstructor = new (url: string) => PushSocketLike

export interface PushClientOptions {
  /** The server's base URL (`http://127.0.0.1:1234`) or the push URL itself. */
  readonly url: string
  readonly token: string
  readonly WebSocket?: PushSocketConstructor
  /** How the client names itself in its hello. */
  readonly client?: string
  readonly backoff?: { readonly baseMs?: number; readonly maxMs?: number }
}

export type Unsubscribe = () => void

interface Subscription {
  readonly streams: Set<(stream: SessionStream) => void>
  readonly exits: Set<(code: number) => void>
  /** The server said the session exited: there is nothing to subscribe to
   *  again after a reconnect, and the listeners stay until their views leave. */
  ended: boolean
  /** The record the server answered the subscribe with, null until it does
   *  (and again after a reconnect, until the new answer). */
  acked: Session | null
  /** Who waits for the next answer: the record, or the server's refusal. */
  waiters: Array<{ resolve: (session: Session) => void; reject: (error: Error) => void }>
}

export const pushUrlOf = (url: string): string => {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:'
  if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = PUSH_PATH
  return parsed.toString()
}

const utf8 = new TextDecoder()
const textOf = (data: unknown): string =>
  typeof data === 'string'
    ? data
    : data instanceof ArrayBuffer
      ? utf8.decode(data)
      : ArrayBuffer.isView(data)
        ? utf8.decode(data)
        : String(data)

const defaultSocket = (): PushSocketConstructor => {
  const ctor = (globalThis as { WebSocket?: PushSocketConstructor }).WebSocket
  if (!ctor) throw new Error('No WebSocket in this environment: pass one in the options')
  return ctor
}

export class PushClient {
  private socket: PushSocketLike | null = null
  private status_: PushStatus = 'idle'
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly url: string
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly eventListeners = new Set<(envelope: ServerEventEnvelope) => void>()
  private readonly statusListeners = new Set<
    (status: PushStatus, detail: PushStatusDetail) => void
  >()
  private readonly errorListeners = new Set<(message: string, sessionId?: string) => void>()
  // ── Lane D (wave 3): the view requests ──
  private readonly requestListeners = new Set<(request: ViewRequest) => void>()
  private openWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  constructor(private readonly options: PushClientOptions) {
    this.url = pushUrlOf(options.url)
  }

  get status(): PushStatus {
    return this.status_
  }

  /** How many times the socket was opened, hello sent; a reconnection adds one. */
  connections = 0

  /** Opens the socket; a second call while it runs does nothing. */
  connect(): this {
    if (this.stopped) throw new Error('This push client was closed')
    if (this.socket) return this
    this.open(this.status_ === 'idle' ? 'connecting' : 'reconnecting')
    return this
  }

  /** Resolves at the next welcome, or rejects when the client gives up. */
  whenOpen(): Promise<void> {
    if (this.status_ === 'open') return Promise.resolve()
    if (this.stopped) return Promise.reject(new Error('This push client was closed'))
    return new Promise((resolve, reject) => this.openWaiters.push({ resolve, reject }))
  }

  /** Ends the client for good: no reconnection, every listener dropped. */
  close(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
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

  /** Frames of one session, exit included, for as long as the handle lives;
   *  several listeners on one session share one subscription on the wire. */
  subscribe(
    sessionId: string,
    onStream: (stream: SessionStream) => void,
    onExit?: (code: number) => void
  ): Unsubscribe {
    let subscription = this.subscriptions.get(sessionId)
    // A new listener on a session the server said had exited asks again: the
    // id may be a resumed session now, and the server is the one to say.
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

  /**
   * The server's answer to this client's subscription on `sessionId`: the
   * session's record, once the `subscribed` frame has arrived (at once when it
   * already has), or a rejection with the server's refusal (an unknown
   * session). This is what makes a subscription something a caller can wait
   * on before writing, as the shell's own subscribe call was: the listener
   * is bound and the session made ready before the promise resolves. There
   * must be a subscription (`subscribe` called first); without one the
   * promise rejects, since nothing was asked of the server.
   */
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

  /** The server's `error` frames: an unknown session, a frame it did not take. */
  onError(listener: (message: string, sessionId?: string) => void): Unsubscribe {
    this.errorListeners.add(listener)
    return () => {
      this.errorListeners.delete(listener)
    }
  }

  // ── Lane D (wave 3): the view requests ──
  /**
   * The view requests the server pushes. Every welcomed client receives each
   * one; a window answers only those carrying its own key, through the
   * `views.answer` request, and the others ignore it.
   */
  onRequest(listener: (request: ViewRequest) => void): Unsubscribe {
    this.requestListeners.add(listener)
    return () => {
      this.requestListeners.delete(listener)
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
    const delay = Math.min(max, base * 2 ** Math.min(attempt - 1, 10)) * (0.5 + Math.random() * 0.5)
    this.setStatus('reconnecting', { code, reason, attempt })
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.stopped) this.open('reconnecting')
    }, delay)
  }

  private receive(text: string): void {
    const decoded = decodeServerFrame(text)
    if (Either.isLeft(decoded)) {
      for (const listener of this.errorListeners)
        listener(`Undecodable frame: ${text.slice(0, 80)}`)
      return
    }
    const frame: ServerFrame = decoded.right
    switch (frame._tag) {
      case 'welcome': {
        this.attempts = 0
        this.setStatus('open', {})
        for (const [sessionId, subscription] of this.subscriptions)
          if (!subscription.ended) {
            // The new socket answers the subscription anew.
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
        // A refusal of a subscription answers whoever waits on it; the
        // subscription itself stays, so a later retry asks again.
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
      // ── Lane D (wave 3): the view requests ──
      case 'request': {
        const request = {
          requestId: frame.requestId,
          windowKey: frame.windowKey,
          command: frame.command,
          payload: frame.payload
        }
        for (const listener of this.requestListeners) this.safely(() => listener(request))
        return
      }
      case 'unsubscribed':
      case 'pong':
        return
    }
  }

  private send(frame: Parameters<typeof encodeClientFrame>[0]): void {
    const socket = this.socket
    if (!socket) return
    try {
      socket.send(encodeClientFrame(frame))
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
      console.error('[clave-client] listener failed', error)
    }
  }
}
