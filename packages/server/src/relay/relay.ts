/**
 * The relay (decision 4 of the mobile spec): one process the team deploys
 * behind TLS, the directory of a person's machines and the road from their
 * phone to them. Plain `node:http` and `ws`, no framework: the same file
 * runs under Bun (`main.ts`, the container image) and under Node (the unit
 * tests, the end-to-end spec's child), and what it does is small enough to
 * read in one sitting. The protocol is `@clave/contract/relay`.
 *
 * Who may do what:
 *
 *  - `GET /health` is open and says nothing a stranger could use.
 *  - `POST /machines/claim`, `GET /machines` and `POST /machines/forget`
 *    take a bearer of the hub, checked at the hub's userinfo endpoint
 *    (`auth.ts`); a person sees and touches the machines of their own
 *    subject and nobody else's.
 *  - `/m/<machineId>/...` is forwarded to the machine as received, the
 *    caller's `Authorization` included: the machine's own listener decides.
 *    The relay answers 404 for a machine it does not know, 503 for one that
 *    is not connected or has too much in flight, 413 for a body beyond the
 *    bound, 504 when the machine does not answer in time, 502 when it could
 *    not perform the request.
 *  - `WS /machines/connect` is a machine's control socket: hello first, with
 *    the credential it claimed; one socket per machine, a newer one closing
 *    the older; a ping every 25 s, 60 s of silence is offline.
 *  - `WS /m/<machineId>/push` is the machine's push channel, tunnelled frame
 *    by frame; the machine opens its own socket to its listener for each.
 *
 * Nothing here logs a header value, keeps a body past the request it belongs
 * to, or holds a token: the hub bearer leaves a hash in the cache, the
 * machine secret a hash in the registry.
 */
import {
  createServer,
  STATUS_CODES,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { Either } from 'effect'
import {
  RELAY_CLAIM_PATH,
  RELAY_CLOSE_FORGOTTEN,
  RELAY_CLOSE_HELLO_TIMEOUT,
  RELAY_CLOSE_MALFORMED,
  RELAY_CLOSE_REPLACED,
  RELAY_CLOSE_SILENT,
  RELAY_CLOSE_STOPPING,
  RELAY_CLOSE_UNAUTHORIZED,
  RELAY_CONNECT_PATH,
  RELAY_FORGET_PATH,
  RELAY_HEALTH_PATH,
  RELAY_HELLO_TIMEOUT_MS,
  RELAY_MACHINES_PATH,
  RELAY_MAX_BODY_BYTES,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_REQUESTS,
  RELAY_MAX_TUNNELS,
  RELAY_OFFLINE_MS,
  RELAY_PING_MS,
  RELAY_PROTOCOL,
  RELAY_PUSH_PATH,
  RELAY_REQUEST_TIMEOUT_MS,
  type MachineFrame,
  type MachineView,
  type RelayFrame,
  type RelayHeaders,
  type RelayHealth,
  decodeForgetMachine,
  decodeMachineFrame,
  decodeMachineRecord,
  encodeRelayFrame,
  parseMachinePath
} from '@clave/contract/relay'
import { HubBearerCheck } from './auth'
import { MachineRegistry } from './registry'

export interface RelayOptions {
  /** Where `machines.json` lives. */
  readonly dataDir: string
  /** The hub's origin, whose userinfo endpoint says who a bearer is. */
  readonly issuer: string
  /** Loopback by default; `0.0.0.0` in a container behind the host's proxy. */
  readonly host?: string
  /** 0, the default, takes a free port. */
  readonly port?: number
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  /** One line per event, never a header value or a token. */
  readonly log?: (line: string) => void
  readonly pingMs?: number
  readonly offlineMs?: number
  readonly helloTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly maxTunnels?: number
  readonly maxRequests?: number
  readonly maxBodyBytes?: number
  readonly authCacheMs?: number
}

export interface Relay {
  readonly url: string
  readonly host: string
  readonly port: number
  /** The ids of the machines connected right now. */
  readonly online: () => string[]
  /** Stop: every machine told, every tunnel and request ended, the listener closed. */
  readonly close: () => Promise<void>
}

interface PendingRequest {
  readonly res: ServerResponse
  headSent: boolean
  done: boolean
  timer: ReturnType<typeof setTimeout> | null
}

interface Tunnel {
  readonly socket: WebSocket
  /** The machine ended it: the phone's close is not echoed back. */
  byMachine: boolean
}

interface Connected {
  readonly id: string
  readonly socket: WebSocket
  lastSeen: number
  readonly requests: Map<string, PendingRequest>
  readonly tunnels: Map<string, Tunnel>
  pingTimer: ReturnType<typeof setInterval> | null
  closed: boolean
}

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
  'content-length'
])

const MAX_JSON_BODY = 64 * 1024

/** The request headers as they go to the machine: everything but the hop's own. */
export function forwardedHeaders(headers: IncomingHttpHeaders): RelayHeaders {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key) || key.startsWith('sec-websocket-')) continue
    if (value === undefined) continue
    out[key] = Array.isArray(value) ? [...value] : value
  }
  return out
}

/** The machine's response headers as they go to the phone: the hop's own
 *  dropped, the length left to this end (set for a whole body, chunked for a stream). */
function answeredHeaders(headers: RelayHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key)) continue
    out[key] = typeof value === 'string' ? value : [...value]
  }
  return out
}

/** A close code `ws` accepts on the wire: a close with no code (1005, what
 *  a socket closed plainly reports) is a normal close, a dropped connection
 *  (1006) is a going-away, anything else outside the sendable ranges is 1011. */
export function sendableCloseCode(code: number | undefined): number {
  if (code === undefined || code === 1005) return 1000
  if (code === 1006) return 1001
  if (code === 1000 || (code >= 1001 && code <= 1013 && code !== 1004)) return code
  if (code >= 3000 && code <= 4999) return code
  return 1011
}

/** A streamed answer a slow caller does not take as it comes is held up to
 *  this, then ended: the relay keeps no body beyond the frames in flight. */
const MAX_STREAM_BUFFER_BYTES = 16 * 1024 * 1024

const rawToBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer)

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text)
  })
  res.end(text)
}

/** The body, whole, or `null` past `max` (the request is then destroyed). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        req.removeAllListeners('data')
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  const reason = STATUS_CODES[status] ?? 'Error'
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`
  )
  socket.destroy()
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => {})
  const pingMs = options.pingMs ?? RELAY_PING_MS
  const offlineMs = options.offlineMs ?? RELAY_OFFLINE_MS
  const helloTimeoutMs = options.helloTimeoutMs ?? RELAY_HELLO_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? RELAY_REQUEST_TIMEOUT_MS
  const maxTunnels = options.maxTunnels ?? RELAY_MAX_TUNNELS
  const maxRequests = options.maxRequests ?? RELAY_MAX_REQUESTS
  const maxBodyBytes = options.maxBodyBytes ?? RELAY_MAX_BODY_BYTES
  const host = options.host ?? '127.0.0.1'

  const registry = MachineRegistry.open(options.dataDir, now)
  const auth = new HubBearerCheck({
    issuer: options.issuer,
    ...(options.fetch && { fetch: options.fetch }),
    now,
    ...(options.authCacheMs !== undefined && { cacheMs: options.authCacheMs }),
    log
  })
  const connected = new Map<string, Connected>()
  const sockets = new Set<Socket>()
  let stopping = false

  const send = (conn: Connected, frame: RelayFrame): void => {
    if (conn.closed || conn.socket.readyState !== WebSocket.OPEN) return
    try {
      conn.socket.send(encodeRelayFrame(frame))
    } catch (error) {
      log(`relay: send to ${conn.id} failed: ${(error as Error).message}`)
    }
  }

  const finish = (conn: Connected, id: string): PendingRequest | undefined => {
    const pending = conn.requests.get(id)
    if (!pending) return undefined
    conn.requests.delete(id)
    pending.done = true
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = null
    return pending
  }

  const fail = (conn: Connected, id: string, status: number, message: string): void => {
    const pending = finish(conn, id)
    if (!pending) return
    if (pending.headSent) pending.res.destroy()
    else json(pending.res, status, { error: message })
  }

  const closeConnected = (conn: Connected, code: number, reason: string): void => {
    if (conn.closed) return
    conn.closed = true
    if (conn.pingTimer) clearInterval(conn.pingTimer)
    conn.pingTimer = null
    if (connected.get(conn.id) === conn) connected.delete(conn.id)
    for (const id of [...conn.requests.keys()])
      fail(conn, id, 503, stopping ? 'the relay is stopping' : 'the machine went away')
    for (const [tunnelId, tunnel] of [...conn.tunnels]) {
      conn.tunnels.delete(tunnelId)
      tunnel.byMachine = true
      try {
        tunnel.socket.close(1001, 'the machine went away')
      } catch {
        /* already gone */
      }
    }
    try {
      registry.touch(conn.id)
    } catch (error) {
      log(`relay: could not record ${conn.id} leaving: ${(error as Error).message}`)
    }
    try {
      conn.socket.close(code, reason)
    } catch {
      /* already gone */
    }
    log(`relay: machine ${conn.id} offline (${reason})`)
  }

  const onMachineFrame = (conn: Connected, frame: MachineFrame): void => {
    switch (frame._tag) {
      case 'hello':
        return send(conn, { _tag: 'error', message: 'Already welcomed' })
      case 'pong':
        return
      case 'response': {
        const pending = finish(conn, frame.id)
        if (!pending) return
        if (pending.headSent) {
          pending.res.destroy()
          return
        }
        const body = Buffer.from(frame.body, 'base64')
        pending.res.writeHead(frame.status, {
          ...answeredHeaders(frame.headers),
          'content-length': body.length
        })
        pending.res.end(body)
        return
      }
      case 'response-head': {
        const pending = conn.requests.get(frame.id)
        if (!pending) return
        if (pending.headSent)
          return send(conn, { _tag: 'error', message: `Head sent twice: ${frame.id}` })
        pending.headSent = true
        pending.res.writeHead(frame.status, answeredHeaders(frame.headers))
        return
      }
      case 'response-chunk': {
        const pending = conn.requests.get(frame.id)
        if (!pending) return
        if (!pending.headSent)
          return send(conn, { _tag: 'error', message: `Chunk before head: ${frame.id}` })
        pending.res.write(Buffer.from(frame.data, 'base64'))
        if (pending.res.writableLength > MAX_STREAM_BUFFER_BYTES) {
          finish(conn, frame.id)
          pending.res.destroy()
          send(conn, { _tag: 'request-abort', id: frame.id })
          log(`relay: a streamed answer to a slow caller was ended at the buffer bound`)
        }
        return
      }
      case 'response-end': {
        const pending = finish(conn, frame.id)
        if (!pending) return
        if (!pending.headSent) {
          json(pending.res, 502, { error: 'the machine ended the answer before its head' })
          return
        }
        pending.res.end()
        return
      }
      case 'response-error':
        return fail(
          conn,
          frame.id,
          502,
          `the machine could not answer: ${frame.message.slice(0, 200)}`
        )
      case 'tunnel-data': {
        const tunnel = conn.tunnels.get(frame.tunnelId)
        if (!tunnel || tunnel.socket.readyState !== WebSocket.OPEN) return
        const bytes = Buffer.from(frame.data, 'base64')
        tunnel.socket.send(frame.binary ? bytes : bytes.toString('utf8'))
        return
      }
      case 'tunnel-close': {
        const tunnel = conn.tunnels.get(frame.tunnelId)
        if (!tunnel) return
        conn.tunnels.delete(frame.tunnelId)
        tunnel.byMachine = true
        try {
          tunnel.socket.close(sendableCloseCode(frame.code), frame.reason ?? '')
        } catch {
          /* already gone */
        }
        return
      }
    }
  }

  /** A machine's socket: hello within the timeout, with a credential the
   *  registry verifies, then the frames of a connected machine. */
  const attachMachine = (socket: WebSocket): void => {
    let conn: Connected | null = null
    const helloTimer = setTimeout(() => {
      if (!conn) socket.close(RELAY_CLOSE_HELLO_TIMEOUT, 'no hello')
    }, helloTimeoutMs)
    socket.on('message', (data) => {
      const text = rawToBuffer(data).toString('utf8')
      const decoded = decodeMachineFrame(text)
      if (conn) {
        conn.lastSeen = now()
        if (Either.isLeft(decoded)) return send(conn, { _tag: 'error', message: 'Malformed frame' })
        try {
          onMachineFrame(conn, decoded.right)
        } catch (error) {
          log(`relay: machine ${conn.id} frame failed: ${(error as Error).message}`)
          closeConnected(conn, 1011, 'relay error')
        }
        return
      }
      if (Either.isLeft(decoded) || decoded.right._tag !== 'hello') {
        clearTimeout(helloTimer)
        socket.close(RELAY_CLOSE_MALFORMED, 'hello first')
        return
      }
      const hello = decoded.right
      const machine = registry.verify(hello.machineId, hello.machineSecret)
      if (!machine) {
        clearTimeout(helloTimer)
        socket.close(RELAY_CLOSE_UNAUTHORIZED, 'unauthorized')
        return
      }
      clearTimeout(helloTimer)
      const previous = connected.get(machine.id)
      if (previous) closeConnected(previous, RELAY_CLOSE_REPLACED, 'replaced')
      registry.touch(machine.id, hello.record)
      conn = {
        id: machine.id,
        socket,
        lastSeen: now(),
        requests: new Map(),
        tunnels: new Map(),
        pingTimer: null,
        closed: false
      }
      connected.set(machine.id, conn)
      const current = conn
      current.pingTimer = setInterval(() => {
        if (now() - current.lastSeen > offlineMs) {
          closeConnected(current, RELAY_CLOSE_SILENT, 'silent')
          return
        }
        send(current, { _tag: 'ping' })
      }, pingMs)
      send(current, { _tag: 'welcome', machineId: machine.id, protocol: RELAY_PROTOCOL })
      log(`relay: machine ${machine.id} online`)
    })
    socket.on('close', (code, reason) => {
      clearTimeout(helloTimer)
      if (conn) closeConnected(conn, code, reason.toString() || 'closed')
    })
    socket.on('error', (error) => {
      log(`relay: machine socket error: ${error.message}`)
    })
  }

  const openTunnel = (conn: Connected, socket: WebSocket, headers: IncomingHttpHeaders): void => {
    const tunnelId = randomBytes(8).toString('hex')
    const tunnel: Tunnel = { socket, byMachine: false }
    conn.tunnels.set(tunnelId, tunnel)
    send(conn, { _tag: 'tunnel-open', tunnelId, headers: forwardedHeaders(headers) })
    socket.on('message', (data, isBinary) => {
      if (conn.closed || socket.readyState !== WebSocket.OPEN) return
      const bytes = rawToBuffer(data)
      // Base64 expands the payload. Isolate this tunnel before its frame
      // could exceed the shared control socket's 16 MiB bound.
      if (bytes.length > RELAY_MAX_BODY_BYTES) {
        socket.close(1009, 'push message too large')
        return
      }
      send(conn, {
        _tag: 'tunnel-data',
        tunnelId,
        data: bytes.toString('base64'),
        ...(isBinary && { binary: true })
      })
    })
    socket.on('close', (code, reason) => {
      conn.tunnels.delete(tunnelId)
      if (!tunnel.byMachine && !conn.closed)
        send(conn, { _tag: 'tunnel-close', tunnelId, code, reason: reason.toString() })
    })
    socket.on('error', () => {})
  }

  const forward = async (
    req: IncomingMessage,
    res: ServerResponse,
    road: { machineId: string; path: string }
  ): Promise<void> => {
    if (!registry.get(road.machineId)) return json(res, 404, { error: 'unknown machine' })
    const conn = connected.get(road.machineId)
    if (!conn) return json(res, 503, { error: 'machine offline' })
    if (req.method === 'CONNECT' || req.method === 'TRACE')
      return json(res, 405, { error: 'method not allowed' })
    if (conn.requests.size >= maxRequests) return json(res, 503, { error: 'machine busy' })
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBodyBytes)
      return json(res, 413, { error: 'body too large' })
    // Reserve capacity before awaiting a chunked upload. Otherwise every
    // unfinished body passes the cap while the requests map stays empty.
    const id = randomBytes(8).toString('hex')
    const pending: PendingRequest = { res, headSent: false, done: false, timer: null }
    conn.requests.set(id, pending)
    pending.timer = setTimeout(() => {
      send(conn, { _tag: 'request-abort', id })
      fail(conn, id, 504, 'the machine did not answer in time')
      if (!req.complete) req.destroy()
    }, requestTimeoutMs)
    res.on('close', () => {
      if (pending.done) return
      finish(conn, id)
      send(conn, { _tag: 'request-abort', id })
      if (!req.complete) req.destroy()
    })
    let body: Buffer | null
    try {
      body = await readBody(req, maxBodyBytes)
    } catch (error) {
      finish(conn, id)
      throw error
    }
    if (pending.done) return
    if (body === null) {
      finish(conn, id)
      json(res, 413, { error: 'body too large' })
      req.destroy()
      return
    }
    if (conn.closed) {
      fail(conn, id, 503, 'machine offline')
      return
    }
    send(conn, {
      _tag: 'request',
      id,
      method: req.method ?? 'GET',
      path: road.path,
      headers: forwardedHeaders(req.headers),
      body: body.toString('base64')
    })
  }

  const authenticated = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<string | null> => {
    const outcome = await auth.check(req.headers['authorization'])
    if (outcome.ok) return outcome.sub
    json(res, outcome.status, {
      error: outcome.status === 401 ? 'unauthorized' : 'the hub did not answer'
    })
    return null
  }

  const jsonBody = async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
    const body = await readBody(req, MAX_JSON_BODY)
    if (body === null) {
      json(res, 413, { error: 'body too large' })
      return undefined
    }
    try {
      return JSON.parse(body.toString('utf8')) as unknown
    } catch {
      json(res, 400, { error: 'invalid json' })
      return undefined
    }
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? '/'
    const pathOnly = url.split('?')[0]
    if (pathOnly === RELAY_HEALTH_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return json(res, 405, { error: 'method not allowed' })
      const health: RelayHealth = {
        status: 'live',
        machines: registry.size,
        online: connected.size
      }
      return json(res, 200, health)
    }
    if (pathOnly === RELAY_CLAIM_PATH) {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      const sub = await authenticated(req, res)
      if (!sub) return
      const body = await jsonBody(req, res)
      if (body === undefined) return
      const record = decodeMachineRecord(body)
      if (Either.isLeft(record)) return json(res, 400, { error: 'invalid machine record' })
      const credential = registry.claim(sub, record.right)
      log(`relay: machine ${credential.machineId} claimed`)
      return json(res, 201, credential)
    }
    if (pathOnly === RELAY_MACHINES_PATH) {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const sub = await authenticated(req, res)
      if (!sub) return
      const machines: MachineView[] = registry.list(sub).map((m) => ({
        id: m.id,
        name: m.record.name,
        platform: m.record.platform,
        version: m.record.version,
        online: connected.has(m.id),
        lastSeen: m.lastSeen,
        direct: m.record.direct
      }))
      return json(res, 200, { machines })
    }
    if (pathOnly === RELAY_FORGET_PATH) {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      const sub = await authenticated(req, res)
      if (!sub) return
      const body = await jsonBody(req, res)
      if (body === undefined) return
      const forget = decodeForgetMachine(body)
      if (Either.isLeft(forget)) return json(res, 400, { error: 'invalid request' })
      if (!registry.forget(sub, forget.right.machineId))
        return json(res, 404, { error: 'unknown machine' })
      const conn = connected.get(forget.right.machineId)
      if (conn) closeConnected(conn, RELAY_CLOSE_FORGOTTEN, 'forgotten')
      log(`relay: machine ${forget.right.machineId} forgotten`)
      return json(res, 200, { ok: true })
    }
    const road = parseMachinePath(url)
    if (road) return forward(req, res, road)
    return json(res, 404, { error: 'not found' })
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      log(`relay: request failed: ${(error as Error).message}`)
      if (!res.headersSent) json(res, 500, { error: 'relay error' })
      else res.destroy()
    })
  })
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_FRAME_BYTES })
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/'
    const pathOnly = url.split('?')[0]
    if (stopping) return refuseUpgrade(socket, 503, 'the relay is stopping')
    if (pathOnly === RELAY_CONNECT_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => attachMachine(ws))
      return
    }
    const road = parseMachinePath(url)
    if (road && road.path.split('?')[0] === RELAY_PUSH_PATH) {
      if (!registry.get(road.machineId)) return refuseUpgrade(socket, 404, 'unknown machine')
      const conn = connected.get(road.machineId)
      if (!conn) return refuseUpgrade(socket, 503, 'machine offline')
      if (conn.tunnels.size >= maxTunnels) return refuseUpgrade(socket, 503, 'too many tunnels')
      wss.handleUpgrade(req, socket, head, (ws) => openTunnel(conn, ws, req.headers))
      return
    }
    refuseUpgrade(socket, 404, 'not found')
  })
  // Node never hands a CONNECT to the request handler: it is refused here,
  // on the raw socket, as the road's 405 (Bun hands it over, and the
  // handler refuses it the same way).
  server.on('connect', (_req, socket: Duplex) => refuseUpgrade(socket, 405, 'method not allowed'))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The relay needs a TCP address')
  const port = address.port
  const shownHost =
    host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host
  const url = `http://${shownHost}:${port}`
  log(`relay: listening on ${url} (${registry.size} machine(s) known)`)

  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      stopping = true
      const closed = new Promise<void>((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
      })
      for (const conn of [...connected.values()])
        closeConnected(conn, RELAY_CLOSE_STOPPING, 'relay stopping')
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      for (const socket of [...sockets]) socket.destroy()
      await closed
    })()
    return closing
  }

  return { url, host, port, online: () => [...connected.keys()], close }
}
