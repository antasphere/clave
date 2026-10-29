/**
 * The relay client in the server (decision 4 of the mobile spec): the
 * machine's end of the road. On a configured relay address it claims a
 * machine credential once, with the owner's access token, keeps it through
 * the store it is given (sealed through the secrets port by the entry that
 * wires it), connects outbound with it, presents the machine record at
 * every connect, and from then on performs the requests the relay forwards
 * against the server's own listener on loopback and pipes each tunnelled
 * push socket to a socket of its own on `/push`. It reconnects with a
 * jittered backoff capped at a minute, asks for the address and the login
 * again every few seconds while either is missing, and says so in the log
 * once per change, never with a token in the line.
 *
 * Nothing here knows the server's token: the phone's own `Authorization`
 * travels in the forwarded request as it was received, and the server's
 * listener authenticates it. The `Origin` header is dropped on the way in,
 * since the listener's cross-origin rule is for browser pages.
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { WebSocket as WsWebSocket, type RawData } from 'ws'
import { Either } from 'effect'
import {
  RELAY_CLAIM_PATH,
  RELAY_CLOSE_FORGOTTEN,
  RELAY_CLOSE_REPLACED,
  RELAY_CLOSE_UNAUTHORIZED,
  RELAY_CONNECT_PATH,
  RELAY_MAX_FRAME_BYTES,
  RELAY_OFFLINE_MS,
  RELAY_PUSH_PATH,
  RELAY_STREAM_THRESHOLD_BYTES,
  type MachineFrame,
  type MachineRecord,
  type RelayFrame,
  type RelayHeaders,
  decodeMachineCredential,
  decodeRelayFrame,
  encodeMachineFrame
} from '@clave/contract/relay'

/** What the machine keeps once it has claimed: the address and the owner it
 *  claimed for (another of either means a new claim), the id and the secret. */
export interface RelayCredential {
  readonly relay: string
  readonly machineId: string
  readonly owner: string
  readonly machineSecret: string
}

/** Where the credential rests: the entry seals the secret on the way out. */
export interface RelayCredentialStore {
  load(): RelayCredential | null
  save(credential: RelayCredential): void
  clear(): void
}

export type RelayClientState =
  | 'unconfigured'
  | 'signed-out'
  | 'claiming'
  | 'connecting'
  | 'connected'
  | 'waiting'
  | 'stopped'

export interface RelayClientStatus {
  readonly state: RelayClientState
  readonly relay: string | null
  readonly machineId: string | null
  /** Epoch milliseconds the state was entered. */
  readonly since: number
  /** Consecutive attempts that did not end connected. */
  readonly attempt: number
  readonly lastFailure: string | null
}

export interface RelayClientOptions {
  /** The relay's address now, or null when none is configured: asked at every attempt. */
  readonly address: () => string | null
  /** The subject signed in, or null: the credential is bound to it. */
  readonly owner: () => string | null
  /** The owner's access token for a claim, or null when nobody is signed in. */
  readonly accessToken: () => Promise<string | null>
  /** The record presented at the claim and at every connect. */
  readonly record: () => MachineRecord
  readonly credentials: RelayCredentialStore
  /** The server's own listener, where a forwarded request is performed. */
  readonly local: { readonly url: string }
  readonly log: (line: string) => void
  readonly fetch?: typeof globalThis.fetch
  /** `ws`'s constructor by default; a test hands its own. */
  readonly WebSocket?: typeof WsWebSocket
  readonly now?: () => number
  readonly backoff?: { readonly baseMs?: number; readonly maxMs?: number }
  /** How long to wait before asking for the address or the login again. */
  readonly idleRetryMs?: number
  /** Silence from the relay (no ping, nothing) that ends the socket. */
  readonly silenceMs?: number
  readonly onStatus?: (status: RelayClientStatus) => void
}

export interface RelayClient {
  status(): RelayClientStatus
  /** Start over now: the connection, if any, is ended and the address, the
   *  owner and the credential are read again at once. What the wiring calls
   *  when the login changes, so a sign-out takes the machine off the relay
   *  without waiting for the next ping, and a sign-in puts it back without
   *  waiting for the idle retry. */
  kick(): void
  /** End the socket and the loop; idempotent. */
  stop(): Promise<void>
}

type SessionOutcome = 'unauthorized' | 'replaced' | 'closed' | 'failed' | 'silent' | 'stopped'

/** Headers that belong to one hop and never travel. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'expect',
  'content-length',
  /** The listener's cross-origin rule is for browser pages; a phone's socket is not one. */
  'origin'
])

const wsUrlOf = (base: string, path: string): string => {
  const url = new URL(base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = path
  url.search = ''
  return url.toString()
}

const joinPath = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path}`

const rawToBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer)

/** The forwarded headers as the local request takes them. */
export function localHeaders(headers: RelayHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key)) continue
    out[key] = typeof value === 'string' ? value : [...value]
  }
  return out
}

function answeredHeaders(res: IncomingMessage): RelayHeaders {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(res.headers)) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key) && key !== 'content-length') continue
    if (value === undefined) continue
    out[key] = Array.isArray(value) ? [...value] : value
  }
  return out
}

class LocalTunnel {
  private readonly queue: Array<string | Buffer> = []
  private open = false
  private ended = false
  readonly socket: WsWebSocket

  constructor(
    url: string,
    WebSocketImpl: typeof WsWebSocket,
    out: (frame: MachineFrame) => void,
    tunnelId: string,
    log: (line: string) => void
  ) {
    this.socket = new WebSocketImpl(url)
    this.socket.on('open', () => {
      this.open = true
      for (const item of this.queue.splice(0)) this.socket.send(item)
    })
    this.socket.on('message', (data, isBinary) => {
      out({
        _tag: 'tunnel-data',
        tunnelId,
        data: rawToBuffer(data).toString('base64'),
        ...(isBinary && { binary: true })
      })
    })
    this.socket.on('close', (code, reason) => {
      if (this.ended) return
      this.ended = true
      out({ _tag: 'tunnel-close', tunnelId, code, reason: reason.toString() })
    })
    this.socket.on('error', (error) => {
      log(`relay: a tunnelled push socket failed: ${error.message}`)
    })
  }

  send(data: string, binary: boolean): void {
    const item = binary ? Buffer.from(data, 'base64') : Buffer.from(data, 'base64').toString('utf8')
    if (this.open) this.socket.send(item)
    else this.queue.push(item)
  }

  /** The relay's end closed: close ours, without telling the relay again. */
  close(code: number | undefined, reason: string | undefined): void {
    this.ended = true
    try {
      this.socket.close(sendableCloseCode(code), reason ?? '')
    } catch {
      this.socket.terminate()
    }
  }
}

/** A close code `ws` accepts on the wire: a close with no code (1005) is a
 *  normal close, a dropped connection (1006) a going-away, the rest 1011. */
function sendableCloseCode(code: number | undefined): number {
  if (code === undefined || code === 1005) return 1000
  if (code === 1006) return 1001
  if (code === 1000 || (code >= 1001 && code <= 1013 && code !== 1004)) return code
  if (code >= 3000 && code <= 4999) return code
  return 1011
}

/** A streamed local answer is paused while the relay's socket holds more
 *  than this, and resumed once it has drained to the low mark: the machine
 *  holds no more of a stream than a slow phone takes. */
const STREAM_HIGH_WATER_BYTES = 8 * 1024 * 1024
const STREAM_LOW_WATER_BYTES = 1024 * 1024

class Client implements RelayClient {
  private state: RelayClientState = 'unconfigured'
  /** The first state is said whatever it is; after that, only a change is. */
  private announced = false
  private since: number
  private attempt = 0
  private lastFailure: string | null = null
  private relay: string | null = null
  private machineId: string | null = null
  private stopped = false
  private socket: WsWebSocket | null = null
  private wake: (() => void) | null = null
  private readonly done: Promise<void>
  private readonly now: () => number
  private readonly fetch: typeof globalThis.fetch
  private readonly WebSocketImpl: typeof WsWebSocket
  private readonly baseMs: number
  private readonly maxMs: number
  private readonly idleRetryMs: number
  private readonly silenceMs: number

  constructor(private readonly options: RelayClientOptions) {
    this.now = options.now ?? (() => Date.now())
    this.since = this.now()
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.WebSocketImpl = options.WebSocket ?? WsWebSocket
    this.baseMs = options.backoff?.baseMs ?? 1_000
    this.maxMs = options.backoff?.maxMs ?? 60_000
    this.idleRetryMs = options.idleRetryMs ?? 15_000
    this.silenceMs = options.silenceMs ?? RELAY_OFFLINE_MS + 5_000
    // The loop never rejects: whatever a provider throws is a state of the
    // client and a line in the log, not an unhandled rejection in the server.
    this.done = this.run().catch((error: unknown) => {
      this.options.log(`relay: the client stopped on an error: ${(error as Error).message}`)
      this.set('stopped', (error as Error).message)
    })
  }

  /** A provider's answer, or `fallback` when it throws: a preferences file
   *  that cannot be read, a login manager that is not ready. Said once. */
  private ask<T>(what: string, read: () => T, fallback: T): T {
    try {
      return read()
    } catch (error) {
      const message = `${what} could not be read: ${(error as Error).message}`
      if (this.lastFailure !== message) this.options.log(`relay: ${message}`)
      this.lastFailure = message
      return fallback
    }
  }

  status(): RelayClientStatus {
    return {
      state: this.state,
      relay: this.relay,
      machineId: this.machineId,
      since: this.since,
      attempt: this.attempt,
      lastFailure: this.lastFailure
    }
  }

  kick(): void {
    if (this.stopped) return
    this.attempt = 0
    const socket = this.socket
    if (socket) {
      try {
        socket.close(1000, 'starting over')
      } catch {
        socket.terminate()
      }
    }
    this.wake?.()
  }

  async stop(): Promise<void> {
    if (this.stopped) return this.done
    this.stopped = true
    this.set('stopped', null)
    this.wake?.()
    const socket = this.socket
    if (socket) {
      try {
        socket.close(1000, 'stopping')
      } catch {
        socket.terminate()
      }
    }
    await this.done
  }

  /** Enter a state, said in the log once per change (the detail included). */
  private set(state: RelayClientState, failure: string | null): void {
    const changed = !this.announced || state !== this.state || failure !== this.lastFailure
    this.announced = true
    this.state = state
    this.lastFailure = failure
    this.since = this.now()
    if (!changed) return
    const words: Record<RelayClientState, string> = {
      unconfigured: 'no relay address is configured, the client waits',
      'signed-out': 'no Antasphere login, the client waits',
      claiming: 'claiming a machine credential',
      connecting: 'connecting',
      connected: `connected as ${this.machineId ?? '?'}`,
      waiting: 'waiting to try again',
      stopped: 'stopped'
    }
    this.options.log(`relay: ${words[state]}${failure ? ` (${failure})` : ''}`)
    this.options.onStatus?.(this.status())
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null
        resolve()
      }, ms)
      timer.unref?.()
      this.wake = () => {
        clearTimeout(timer)
        this.wake = null
        resolve()
      }
    })
  }

  /** The next wait: the base doubled per attempt up to the cap, with jitter
   *  between half the figure and the figure, so a fleet does not knock as one. */
  private backoffMs(): number {
    const cap = Math.min(this.maxMs, this.baseMs * 2 ** Math.max(0, this.attempt - 1))
    return Math.round(cap / 2 + Math.random() * (cap / 2))
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const address = this.ask('the relay address', () => this.options.address(), null)
      if (!address) {
        this.relay = null
        this.set('unconfigured', this.lastFailure)
        await this.sleep(this.idleRetryMs)
        continue
      }
      this.relay = address
      const owner = this.ask('the owner', () => this.options.owner(), null)
      if (!owner) {
        this.set('signed-out', this.lastFailure)
        await this.sleep(this.idleRetryMs)
        continue
      }
      let credential = this.ask(
        'the machine credential',
        () => this.options.credentials.load(),
        null
      )
      if (credential && (credential.relay !== address || credential.owner !== owner)) {
        this.options.credentials.clear()
        credential = null
      }
      if (!credential) {
        this.set('claiming', null)
        const token = await this.options.accessToken().catch((error: unknown) => {
          this.options.log(`relay: the access token could not be read: ${(error as Error).message}`)
          return null
        })
        if (this.stopped) break
        if (!token) {
          this.set('signed-out', 'the login has no usable token')
          await this.sleep(this.idleRetryMs)
          continue
        }
        try {
          credential = await this.claim(address, token, owner)
          this.options.credentials.save(credential)
          this.options.log(`relay: machine credential claimed (${credential.machineId})`)
        } catch (error) {
          this.attempt++
          this.set('waiting', `the claim failed: ${(error as Error).message}`)
          await this.sleep(this.backoffMs())
          continue
        }
      }
      this.machineId = credential.machineId
      this.set('connecting', null)
      const outcome = await this.session(address, credential)
      if (this.stopped) break
      if (outcome === 'unauthorized') {
        // The relay no longer knows this credential (its store reset, the
        // owner forgot the machine): claim anew, with the backoff so a
        // relay that refuses every claim is not hammered.
        this.options.credentials.clear()
        this.machineId = null
        this.attempt++
        this.set('waiting', 'the relay refused the machine credential')
        await this.sleep(this.backoffMs())
        continue
      }
      this.attempt++
      this.set(
        'waiting',
        outcome === 'closed' ? 'the connection ended' : `the connection ${outcome}`
      )
      await this.sleep(this.backoffMs())
    }
    this.set('stopped', null)
  }

  private async claim(address: string, token: string, owner: string): Promise<RelayCredential> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 15_000)
    let response: Response
    try {
      response = await this.fetch(joinPath(address, RELAY_CLAIM_PATH), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.options.record()),
        signal: abort.signal
      })
    } finally {
      clearTimeout(timer)
    }
    if (response.status === 401) {
      await response.body?.cancel()
      throw new Error('the relay refused the login')
    }
    if (response.status !== 201 && response.status !== 200) {
      await response.body?.cancel()
      throw new Error(`the relay answered ${response.status}`)
    }
    const decoded = decodeMachineCredential(await response.json())
    if (Either.isLeft(decoded)) throw new Error('the relay answered no credential')
    return {
      relay: address,
      owner,
      machineId: decoded.right.machineId,
      machineSecret: decoded.right.machineSecret
    }
  }

  /** One connection, from open to close; the outcome says why it ended. */
  private session(address: string, credential: RelayCredential): Promise<SessionOutcome> {
    return new Promise((resolve) => {
      const socket = new this.WebSocketImpl(wsUrlOf(address, RELAY_CONNECT_PATH), {
        maxPayload: RELAY_MAX_FRAME_BYTES
      })
      this.socket = socket
      let welcomed = false
      let settled = false
      const pending = new Map<string, ClientRequest>()
      const tunnels = new Map<string, LocalTunnel>()
      let silence: ReturnType<typeof setTimeout> | null = null
      const heard = (): void => {
        if (silence) clearTimeout(silence)
        silence = setTimeout(() => {
          this.options.log('relay: nothing heard from the relay, reconnecting')
          socket.terminate()
          finish('silent')
        }, this.silenceMs)
        silence.unref?.()
      }
      const out = (frame: MachineFrame): void => {
        if (socket.readyState !== WsWebSocket.OPEN) return
        try {
          socket.send(encodeMachineFrame(frame))
        } catch (error) {
          this.options.log(`relay: send failed: ${(error as Error).message}`)
        }
      }
      const finish = (outcome: SessionOutcome): void => {
        if (settled) return
        settled = true
        if (silence) clearTimeout(silence)
        for (const req of pending.values()) req.destroy()
        pending.clear()
        for (const tunnel of tunnels.values()) tunnel.close(1001, 'the relay went away')
        tunnels.clear()
        if (this.socket === socket) this.socket = null
        resolve(this.stopped ? 'stopped' : outcome)
      }
      socket.on('open', () => {
        heard()
        out({
          _tag: 'hello',
          machineId: credential.machineId,
          machineSecret: credential.machineSecret,
          record: this.options.record()
        })
      })
      socket.on('message', (data) => {
        heard()
        const decoded = decodeRelayFrame(rawToBuffer(data).toString('utf8'))
        if (Either.isLeft(decoded)) {
          this.options.log('relay: a frame from the relay could not be read')
          return
        }
        try {
          this.onFrame(decoded.right, {
            out,
            pending,
            tunnels,
            buffered: () => socket.bufferedAmount,
            onWelcome: () => (welcomed = true)
          })
        } catch (error) {
          this.options.log(`relay: a frame failed: ${(error as Error).message}`)
        }
      })
      socket.on('close', (code) => {
        finish(
          code === RELAY_CLOSE_UNAUTHORIZED || code === RELAY_CLOSE_FORGOTTEN
            ? 'unauthorized'
            : code === RELAY_CLOSE_REPLACED
              ? 'replaced'
              : welcomed
                ? 'closed'
                : 'failed'
        )
      })
      socket.on('error', (error) => {
        if (!welcomed) this.lastFailure = error.message
      })
    })
  }

  private onFrame(
    frame: RelayFrame,
    io: {
      out: (frame: MachineFrame) => void
      pending: Map<string, ClientRequest>
      tunnels: Map<string, LocalTunnel>
      buffered: () => number
      onWelcome: () => void
    }
  ): void {
    switch (frame._tag) {
      case 'welcome':
        io.onWelcome()
        this.attempt = 0
        this.machineId = frame.machineId
        this.set('connected', null)
        return
      case 'ping':
        return io.out({ _tag: 'pong' })
      case 'request':
        return this.perform(frame, io)
      case 'request-abort': {
        const req = io.pending.get(frame.id)
        if (!req) return
        io.pending.delete(frame.id)
        req.destroy()
        return
      }
      case 'tunnel-open': {
        if (io.tunnels.has(frame.tunnelId)) return
        const tunnel = new LocalTunnel(
          wsUrlOf(this.options.local.url, RELAY_PUSH_PATH),
          this.WebSocketImpl,
          (f) => {
            if (f._tag === 'tunnel-close') io.tunnels.delete(frame.tunnelId)
            io.out(f)
          },
          frame.tunnelId,
          this.options.log
        )
        io.tunnels.set(frame.tunnelId, tunnel)
        return
      }
      case 'tunnel-data':
        return io.tunnels.get(frame.tunnelId)?.send(frame.data, frame.binary === true)
      case 'tunnel-close': {
        const tunnel = io.tunnels.get(frame.tunnelId)
        if (!tunnel) return
        io.tunnels.delete(frame.tunnelId)
        tunnel.close(frame.code, frame.reason)
        return
      }
      case 'error':
        this.options.log(`relay: the relay refused a frame: ${frame.message}`)
        return
    }
  }

  /** Perform a forwarded request against the local listener and answer it:
   *  a body of known length under the threshold in one frame, the rest streamed. */
  private perform(
    frame: Extract<RelayFrame, { _tag: 'request' }>,
    io: {
      out: (frame: MachineFrame) => void
      pending: Map<string, ClientRequest>
      buffered: () => number
    }
  ): void {
    const local = new URL(this.options.local.url)
    const body = Buffer.from(frame.body, 'base64')
    const headers = localHeaders(frame.headers)
    headers['content-length'] = String(body.length)
    let path: string
    try {
      const target = new URL(frame.path, local)
      if (target.origin !== local.origin) throw new Error('off the listener')
      path = `${target.pathname}${target.search}`
    } catch {
      io.out({ _tag: 'response-error', id: frame.id, message: 'the path is not a path' })
      return
    }
    const req = httpRequest({
      host: local.hostname,
      port: Number(local.port),
      method: frame.method,
      path,
      headers
    })
    io.pending.set(frame.id, req)
    req.on('response', (res) => {
      const length = Number(res.headers['content-length'])
      const known = Number.isFinite(length) && length <= RELAY_STREAM_THRESHOLD_BYTES
      if (known) {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          io.pending.delete(frame.id)
          io.out({
            _tag: 'response',
            id: frame.id,
            status: res.statusCode ?? 502,
            headers: answeredHeaders(res),
            body: Buffer.concat(chunks).toString('base64')
          })
        })
      } else {
        io.out({
          _tag: 'response-head',
          id: frame.id,
          status: res.statusCode ?? 502,
          headers: answeredHeaders(res)
        })
        res.on('data', (chunk: Buffer) => {
          io.out({ _tag: 'response-chunk', id: frame.id, data: chunk.toString('base64') })
          if (io.buffered() <= STREAM_HIGH_WATER_BYTES) return
          res.pause()
          const drain = setInterval(() => {
            if (io.buffered() > STREAM_LOW_WATER_BYTES) return
            clearInterval(drain)
            res.resume()
          }, 50)
          drain.unref?.()
        })
        res.on('end', () => {
          io.pending.delete(frame.id)
          io.out({ _tag: 'response-end', id: frame.id })
        })
      }
      res.on('error', (error) => {
        io.pending.delete(frame.id)
        io.out({ _tag: 'response-error', id: frame.id, message: error.message })
      })
    })
    req.on('error', (error) => {
      if (!io.pending.has(frame.id)) return
      io.pending.delete(frame.id)
      io.out({ _tag: 'response-error', id: frame.id, message: error.message })
    })
    req.end(body)
  }
}

export function startRelayClient(options: RelayClientOptions): RelayClient {
  return new Client(options)
}
