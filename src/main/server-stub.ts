/**
 * The server, until lane A's package exists (PRDCT-3152).
 *
 * What the Electron shell needs from the server in this wave is small: a
 * loopback listener with a bearer token, the framework's two health probes,
 * and a client registry the shell announces itself to. This module is that
 * and nothing more, in plain `node:http`, so the same code runs in-process
 * inside Electron main (`server-boot.ts`) and as its own process under Bun
 * (`server-entry.ts`). It imports nothing from Electron and nothing from the
 * framework: when `packages/server` merges, `server-boot.ts` starts that
 * instead and this file goes.
 *
 * The HTTP shape is the one ADR 0003 records as the shell's expectation:
 *
 *   GET  /health/live        -> 200 { status: "live" }          (no token)
 *   GET  /health/ready       -> 200 { ready, checks }           (no token)
 *   POST /clients            -> 201 { id, kind, pid, version, since }
 *   GET  /clients            -> 200 { clients: [...] }
 *   DELETE /clients/:id      -> 204
 *
 * Everything but the probes needs `Authorization: Bearer <token>`; a wrong or
 * missing token is a 401, compared in constant time as the MCP server does.
 */
import * as http from 'http'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'

export interface ServerClientRecord {
  id: string
  kind: string
  pid: number
  version: string
  since: string
}

export interface StubServer {
  url: string
  token: string
  port: number
  /** The registered clients right now (the registry is in memory). */
  clients: () => ServerClientRecord[]
  stop: () => Promise<void>
}

export interface StubServerOptions {
  /** 0 asks the OS for a free port. */
  port?: number
  /** A token to use instead of a fresh random one (the standalone entry can be told one). */
  token?: string
}

const HOST = '127.0.0.1'

function sameToken(presented: string | undefined, expected: string): boolean {
  if (!presented) return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function bearerOf(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return undefined
  return header.slice('Bearer '.length).trim()
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

/** Start the stub on the loopback. Resolves once the port is bound. */
export async function startStubServer(options: StubServerOptions = {}): Promise<StubServer> {
  const token = options.token ?? randomBytes(32).toString('hex')
  const clients = new Map<string, ServerClientRecord>()
  let nextId = 1

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${HOST}`)
    const method = req.method ?? 'GET'

    if (method === 'GET' && url.pathname === '/health/live')
      return send(res, 200, { status: 'live' })
    if (method === 'GET' && url.pathname === '/health/ready')
      return send(res, 200, { ready: true, checks: [] })

    if (!sameToken(bearerOf(req), token)) return send(res, 401, { error: 'unauthorized' })

    if (url.pathname === '/clients') {
      if (method === 'GET') return send(res, 200, { clients: [...clients.values()] })
      if (method === 'POST') {
        let body: Record<string, unknown>
        try {
          body = (await readJson(req)) as Record<string, unknown>
        } catch {
          return send(res, 400, { error: 'invalid json' })
        }
        const pid = Number(body.pid)
        const kind = typeof body.kind === 'string' ? body.kind : ''
        if (!kind || !Number.isInteger(pid) || pid <= 0)
          return send(res, 400, { error: 'kind and pid are required' })
        const record: ServerClientRecord = {
          id: `c${nextId++}`,
          kind,
          pid,
          version: typeof body.version === 'string' ? body.version : '',
          since: new Date().toISOString()
        }
        clients.set(record.id, record)
        return send(res, 201, record)
      }
      return send(res, 405, { error: 'method not allowed' })
    }

    const client = /^\/clients\/([^/]+)$/.exec(url.pathname)
    if (client && method === 'DELETE') {
      if (!clients.delete(client[1])) return send(res, 404, { error: 'no such client' })
      return send(res, 204)
    }

    return send(res, 404, { error: 'not found' })
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[server] request failed', err)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, HOST, () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('Could not determine the server port'))
    })
  })

  return {
    url: `http://${HOST}:${port}`,
    token,
    port,
    clients: () => [...clients.values()],
    stop: () =>
      new Promise<void>((resolve) => {
        // Drop keep-alive connections too, or the port stays taken while the
        // next instance boots (the same reason stopMcpServer does it).
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}
