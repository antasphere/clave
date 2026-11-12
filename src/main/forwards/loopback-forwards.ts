/**
 * The Mac's hop of the forward carrier (PRDCT-4473): a page a server serves
 * on its own loopback, framed in a Clave window here. Each forward is one
 * listener on this Mac's `127.0.0.1`, on a port of its own, so the page sits
 * at the root of its own origin exactly as it would on the server (its
 * root-absolute URLs, its own-origin checks and its event stream all keep
 * working untouched), and every request it makes is relayed to the server's
 * `/forward/<lease>/…` with the server's bearer token added here.
 *
 * The listener is reachable by anything on this Mac, so it answers only
 * what proves to be one of Clave's own windows: the window gate
 * (`window-gate.ts`) stamps a per-listener secret on the requests of Clave's
 * sessions, and a request without it is refused before anything is relayed.
 * The token never reaches the page and the page never names its own Origin
 * to the server: this hop says whether the Origin was the page's own.
 *
 * Imports no Electron, so the whole chain is tested under plain Node.
 */
import http from 'node:http'
import https from 'node:https'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { pipeline, type Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  FORWARD_HOLD_LIMIT,
  FORWARD_ORIGIN_HEADER,
  FORWARD_PATH,
  FORWARD_REFUSED,
  FORWARD_REFUSED_HEADER,
  FORWARD_SELF_ORIGIN,
  HOP_BY_HOP_HEADERS,
  connectionListed,
  relayCloseCode
} from '@clave/contract/forward'
import { type AwayReason, awayPage } from './away-page'

/** The header main adds to the requests of Clave's own windows; the listener refuses a request without it. */
export const WINDOW_HEADER = 'x-clave-window'

export interface ForwardUpstream {
  /** The server's base URL. */
  readonly url: string
  /** The server's bearer token. */
  readonly token: string
}

export interface OpenForwardInput {
  /** One listener per key; a second open of the same key joins it. */
  readonly key: string
  readonly lease: string
  /** Asked at every request, so a token changed in Settings is used at once. */
  readonly upstream: () => Promise<ForwardUpstream>
}

export interface OpenedForward {
  /** `http://127.0.0.1:<port>/` */
  readonly url: string
  readonly port: number
  /** Idempotent; the last holder closes the listener. */
  readonly release: () => void
}

/** Equal in constant time, whatever the lengths: both sides are hashed first. */
const safeEqual = (presented: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(expected).digest()
  )

/** The names a request to the server never carries from the page: the
 *  hop's own, the window's secret, the page's credentials and identity, and
 *  the origin report, which only this hop may write. */
const DROPPED_UP = new Set([
  WINDOW_HEADER,
  'cookie',
  'host',
  'origin',
  'authorization',
  FORWARD_ORIGIN_HEADER
])

interface Listener {
  readonly key: string
  readonly lease: string
  readonly port: number
  readonly secret: string
  readonly server: http.Server
  readonly upstream: () => Promise<ForwardUpstream>
  readonly sockets: Set<WebSocket>
  /** One keep-alive pool per forward, per protocol the server is reached by. */
  agents: { http?: http.Agent; https?: https.Agent }
  holders: number
  closed: boolean
}

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(', ') : value

/** The server's base, the path the forward is under, and the module that speaks to it. */
const target = (
  upstream: ForwardUpstream,
  lease: string,
  rest: string
): { url: URL; path: string; secure: boolean } => {
  const url = new URL(upstream.url)
  const base = url.pathname.replace(/\/+$/, '')
  // String concatenation, never `new URL(rest, …)`: a `..` in the page's
  // path is the page's to read on the server, never resolved away here.
  return { url, path: `${base}${FORWARD_PATH}/${lease}${rest}`, secure: url.protocol === 'https:' }
}

export class LoopbackForwards {
  private readonly listeners = new Map<string, Promise<Listener>>()
  private readonly open_ = new Map<string, Listener>()
  private readonly changeListeners = new Set<() => void>()
  private readonly log: (line: string) => void
  /** The protocol the page's side of a relayed socket is answered with: the
   *  one the server's side chose, keyed by the upgrade request. */
  private readonly chosenProtocol = new WeakMap<http.IncomingMessage, string>()
  private readonly pages: WebSocketServer

  constructor(deps?: { readonly log?: (line: string) => void }) {
    this.log = deps?.log ?? (() => undefined)
    this.pages = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      handleProtocols: (_offered, request) => this.chosenProtocol.get(request) ?? false
    })
  }

  async open(input: OpenForwardInput): Promise<OpenedForward> {
    let pending = this.listeners.get(input.key)
    if (!pending) {
      pending = this.listen(input)
      this.listeners.set(input.key, pending)
      pending.catch(() => this.listeners.delete(input.key))
    }
    const listener = await pending
    listener.holders += 1
    let released = false
    return {
      url: `http://127.0.0.1:${listener.port}/`,
      port: listener.port,
      release: () => {
        if (released) return
        released = true
        listener.holders -= 1
        if (listener.holders <= 0) this.close(listener)
      }
    }
  }

  /** port → secret, for the window gate. */
  secrets(): ReadonlyMap<number, string> {
    const map = new Map<number, string>()
    for (const listener of this.open_.values()) map.set(listener.port, listener.secret)
    return map
  }

  /** The set of ports changed. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  async closeAll(): Promise<void> {
    const all = await Promise.allSettled([...this.listeners.values()])
    for (const settled of all) if (settled.status === 'fulfilled') this.close(settled.value)
  }

  private changed(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener()
      } catch {
        // One listener's failure is its own.
      }
    }
  }

  private async listen(input: OpenForwardInput): Promise<Listener> {
    const server = http.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const listener: Listener = {
      key: input.key,
      lease: input.lease,
      port: (server.address() as AddressInfo).port,
      secret: randomBytes(32).toString('hex'),
      server,
      upstream: input.upstream,
      sockets: new Set(),
      agents: {},
      holders: 0,
      closed: false
    }
    server.on('request', (req, res) => this.request(listener, req, res))
    server.on('upgrade', (req, socket, head) => this.upgrade(listener, req, socket, head))
    this.open_.set(input.key, listener)
    this.changed()
    return listener
  }

  private close(listener: Listener): void {
    if (listener.closed) return
    listener.closed = true
    this.listeners.delete(listener.key)
    this.open_.delete(listener.key)
    listener.server.close()
    listener.server.closeAllConnections()
    for (const socket of listener.sockets) socket.close(1001)
    listener.sockets.clear()
    listener.agents.http?.destroy()
    listener.agents.https?.destroy()
    this.changed()
  }

  /**
   * Checks 1 to 3, for a request and an upgrade alike. The `Host` check is
   * the guard against DNS rebinding: a page of another site whose name was
   * pointed at 127.0.0.1 reaches this port with its own name as `Host`.
   * The window header proves the request comes from a Clave window.
   */
  private admit(listener: Listener, req: http.IncomingMessage, socket = false): 200 | 400 | 403 {
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== `127.0.0.1:${listener.port}` && host !== `localhost:${listener.port}`) return 403
    const presented = one(req.headers[WINDOW_HEADER])
    if (presented === undefined || !safeEqual(presented, listener.secret)) return 403
    if (!(req.url ?? '').startsWith('/')) return 400
    // A write or a socket from another origin stops here. The window gate
    // stamps every request a Clave window sends to this port, whichever page
    // of the window made it, so the secret says "a Clave window" and not
    // "this page": without this, one forwarded page could post to another's
    // server, or open a socket on it (a WebSocket is not held by the
    // same-origin rule a read is). A read from elsewhere still passes, and
    // the browser keeps its answer from the page that asked.
    const origin = one(req.headers.origin)
    const reads = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
    if (origin !== undefined && !this.ownOrigin(listener, origin) && (socket || !reads)) return 403
    return 200
  }

  private ownOrigin(listener: Listener, origin: string): boolean {
    return (
      origin === `http://127.0.0.1:${listener.port}` ||
      origin === `http://localhost:${listener.port}`
    )
  }

  /** The headers the server receives: the page's own, minus what never
   *  crosses, plus the bearer and the origin report. */
  private upHeaders(
    listener: Listener,
    req: http.IncomingMessage,
    token: string
  ): Record<string, string> {
    const listed = connectionListed(req.headers.connection)
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (HOP_BY_HOP_HEADERS.has(name) || listed.has(name) || DROPPED_UP.has(name)) continue
      out[name] = Array.isArray(value) ? value.join(', ') : value
    }
    out['authorization'] = `Bearer ${token}`
    const origin = one(req.headers.origin)
    if (origin !== undefined)
      out[FORWARD_ORIGIN_HEADER] = this.ownOrigin(listener, origin) ? FORWARD_SELF_ORIGIN : origin
    return out
  }

  private agentFor(listener: Listener, secure: boolean): http.Agent {
    if (secure)
      return (listener.agents.https ??= new https.Agent({ keepAlive: true, maxSockets: 16 }))
    return (listener.agents.http ??= new http.Agent({ keepAlive: true, maxSockets: 16 }))
  }

  private away(req: http.IncomingMessage, res: http.ServerResponse, reason: AwayReason): void {
    if (res.headersSent) {
      res.destroy()
      return
    }
    const accept = one(req.headers.accept) ?? ''
    const navigation =
      one(req.headers['sec-fetch-mode']) === 'navigate' || accept.includes('text/html')
    if (navigation) {
      res.writeHead(503, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(awayPage(reason))
    } else {
      res.writeHead(502, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(
        `The server behind this page is ${reason === 'unreachable' ? 'unreachable' : 'not showing it'}.\n`
      )
    }
  }

  private request(listener: Listener, req: http.IncomingMessage, res: http.ServerResponse): void {
    const admitted = this.admit(listener, req)
    if (admitted !== 200) {
      req.resume()
      res.writeHead(admitted, { 'content-type': 'text/plain' })
      res.end(admitted === 403 ? 'Forbidden' : 'Bad Request')
      return
    }
    res.socket?.setNoDelay(true)
    void listener.upstream().then(
      (upstream) => this.relay(listener, req, res, upstream),
      () => {
        this.log(`[forwards] ${listener.key}: the server's address could not be read`)
        req.resume()
        this.away(req, res, 'unreachable')
      }
    )
  }

  private relay(
    listener: Listener,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    upstream: ForwardUpstream
  ): void {
    if (res.destroyed) return
    const { url, path, secure } = target(upstream, listener.lease, req.url ?? '/')
    const out = (secure ? https : http).request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (secure ? 443 : 80),
      method: req.method,
      path,
      headers: this.upHeaders(listener, req, upstream.token),
      agent: this.agentFor(listener, secure)
    })
    out.setNoDelay(true)
    out.on('response', (answer) => {
      const status = answer.statusCode ?? 502
      if (status === 401 || answer.headers[FORWARD_REFUSED_HEADER] === FORWARD_REFUSED) {
        answer.resume()
        return this.away(req, res, status === 401 ? 'refused' : 'gone')
      }
      const listed = connectionListed(answer.headers.connection)
      const headers: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value === undefined) continue
        if (HOP_BY_HOP_HEADERS.has(name) || listed.has(name)) continue
        if (name === 'set-cookie' || name === FORWARD_REFUSED_HEADER) continue
        headers[name] = value
      }
      res.writeHead(status, headers)
      res.flushHeaders()
      // `pipeline`, not `pipe`: when the server breaks off half-way (it
      // stopped, the network dropped) the page's answer is ended too, where
      // a bare pipe would leave the frame waiting on it for ever.
      pipeline(answer, res, () => undefined)
    })
    out.on('error', () => {
      if (!res.headersSent) {
        this.log(`[forwards] ${listener.key}: the server did not answer`)
        this.away(req, res, 'unreachable')
      } else res.destroy()
    })
    // The page went away (a frame closed, an event stream dropped): the
    // request to the server goes with it, never left holding a socket.
    res.on('close', () => {
      if (!res.writableFinished) out.destroy()
    })
    req.pipe(out)
  }

  private upgrade(
    listener: Listener,
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void {
    const admitted = this.admit(listener, req, true)
    if (admitted !== 200) {
      socket.write(
        admitted === 403 ? 'HTTP/1.1 403 Forbidden\r\n\r\n' : 'HTTP/1.1 400 Bad Request\r\n\r\n'
      )
      socket.destroy()
      return
    }
    const refuse = (): void => {
      if (socket.destroyed) return
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
    }
    void listener.upstream().then(
      (upstream) => this.relaySocket(listener, req, socket, head, upstream, refuse),
      () => refuse()
    )
  }

  /** The server's socket first, the page's handshake only once it is open,
   *  so a refusal is still an HTTP answer to the page. */
  private relaySocket(
    listener: Listener,
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    upstream: ForwardUpstream,
    refuse: () => void
  ): void {
    const { url, path, secure } = target(upstream, listener.lease, req.url ?? '/')
    const offered = (one(req.headers['sec-websocket-protocol']) ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    const headers = this.upHeaders(listener, req, upstream.token)
    const sent: Record<string, string> = { authorization: headers['authorization']! }
    if (headers[FORWARD_ORIGIN_HEADER] !== undefined)
      sent[FORWARD_ORIGIN_HEADER] = headers[FORWARD_ORIGIN_HEADER]
    const server = new WebSocket(`${secure ? 'wss' : 'ws'}://${url.host}${path}`, offered, {
      headers: sent,
      perMessageDeflate: false,
      // A server that takes the connection and never answers the handshake.
      handshakeTimeout: 30_000
    })
    listener.sockets.add(server)
    let held: Array<{ data: Buffer; binary: boolean }> = []
    let heldBytes = 0
    let page: WebSocket | null = null
    const early = (data: RawData, binary: boolean): void => {
      const buffer = asBuffer(data)
      heldBytes += buffer.length
      if (heldBytes > FORWARD_HOLD_LIMIT) {
        server.close(1009)
        refuse()
      } else held.push({ data: buffer, binary })
    }
    let decided = false
    const fail = (): void => {
      if (decided) return
      decided = true
      listener.sockets.delete(server)
      server.terminate()
      refuse()
    }
    socket.once('close', () => {
      if (!decided) fail()
    })
    server.once('unexpected-response', (request, response) => {
      response.resume()
      request.destroy()
      fail()
    })
    server.on('error', () => {
      if (!decided) fail()
      else if (page && page.readyState === WebSocket.OPEN) page.close(1011)
    })
    server.on('message', (data, binary) => {
      if (page) page.send(asBuffer(data), { binary })
      else early(data, binary)
    })
    server.once('open', () => {
      if (decided || listener.closed || socket.destroyed) {
        decided = true
        server.close(1001)
        return
      }
      decided = true
      this.chosenProtocol.set(req, server.protocol)
      this.pages.handleUpgrade(req, socket, head, (accepted) => {
        page = accepted
        listener.sockets.add(page)
        for (const frame of held) page.send(frame.data, { binary: frame.binary })
        held = []
        heldBytes = 0
        page.on('message', (data, binary) => {
          if (server.readyState === WebSocket.OPEN) server.send(asBuffer(data), { binary })
        })
        page.on('close', (code, reason) => {
          listener.sockets.delete(accepted)
          if (server.readyState === WebSocket.OPEN || server.readyState === WebSocket.CONNECTING)
            server.close(relayCloseCode(code), reason)
        })
        page.on('error', () => {
          if (server.readyState === WebSocket.OPEN) server.close(1011)
        })
        // The server's side may have closed while the handshake was taken.
        if (server.readyState !== WebSocket.OPEN) page.close(1011)
      })
    })
    server.on('close', (code, reason) => {
      listener.sockets.delete(server)
      if (page && (page.readyState === WebSocket.OPEN || page.readyState === WebSocket.CONNECTING))
        page.close(relayCloseCode(code), reason)
    })
  }
}

const asBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer)
