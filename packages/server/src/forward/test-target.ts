/**
 * The page the forward tests relay to (PRDCT-4473): a plain `node:http`
 * server on `127.0.0.1` that records what it receives, with a WebSocket
 * echo beside it. Test-only; the forward tests of both hops import it.
 */
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'

export const BIG_BYTES = 5 * 1024 * 1024

/** The 5 MiB the target streams on `/big`, the same bytes every time. */
export const bigBody = (): Buffer => {
  const body = Buffer.alloc(BIG_BYTES)
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff
  return body
}

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

export interface Received {
  readonly method: string
  readonly url: string
  readonly headers: http.IncomingHttpHeaders
}

export interface SocketSeen {
  readonly url: string
  readonly protocol: string
  readonly headers: http.IncomingHttpHeaders
}

export interface TestTarget {
  readonly port: number
  /** Every HTTP request, in order. */
  readonly received: Received[]
  /** Every WebSocket handshake taken. */
  readonly sockets: SocketSeen[]
  /** Resolves when the answer to the next request on `path` closes. */
  closeOf(path: string): Promise<void>
  stop(): Promise<void>
}

export async function startTestTarget(): Promise<TestTarget> {
  const received: Received[] = []
  const sockets: SocketSeen[] = []
  const closeWaiters = new Map<string, () => void>()
  const big = bigBody()
  const timers = new Set<NodeJS.Timeout>()
  const connections = new Set<Socket>()

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    received.push({ method: req.method ?? '', url, headers: req.headers })
    const path = url.split('?')[0]
    res.on('close', () => {
      const waiter = closeWaiters.get(path!)
      if (waiter) {
        closeWaiters.delete(path!)
        waiter()
      }
    })
    if (path === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.flushHeaders()
      const tick = setInterval(() => res.write('event: tick\ndata: 1\n\n'), 50)
      timers.add(tick)
      res.on('close', () => {
        clearInterval(tick)
        timers.delete(tick)
      })
      return
    }
    if (path === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      let offset = 0
      const pump = (): void => {
        while (offset < big.length) {
          const chunk = big.subarray(offset, offset + 64 * 1024)
          offset += chunk.length
          if (!res.write(chunk)) {
            res.once('drain', pump)
            return
          }
        }
        res.end()
      }
      pump()
      return
    }
    if (path === '/upload') {
      const hash = createHash('sha256')
      let bytes = 0
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        hash.update(chunk)
      })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ bytes, sha256: hash.digest('hex') }))
      })
      return
    }
    if (path === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('the target has no such thing')
      return
    }
    if (path === '/spoof') {
      // A page that marks its own answer the way the server marks a refusal.
      res.writeHead(200, { 'content-type': 'text/plain', 'x-clave-forward': 'refused' })
      res.end('page-made')
      return
    }
    // Everything else is the echo, `/echo` and any path a test sends.
    req.resume()
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'a=b',
        'x-target': 'yes',
        'x-hop': 'listed in connection',
        'keep-alive': 'timeout=5',
        connection: 'keep-alive, x-hop'
      })
      res.end(JSON.stringify({ method: req.method, url, headers: req.headers }))
    })
  })
  server.on('connection', (socket) => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/'
    if (url !== '/ws' && url !== '/ws-close') {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      sockets.push({ url, protocol: ws.protocol, headers: req.headers })
      if (url === '/ws-close') {
        ws.close(4321, 'bye')
        return
      }
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    received,
    sockets,
    closeOf: (path) => new Promise<void>((resolve) => closeWaiters.set(path, resolve)),
    stop: async () => {
      for (const timer of timers) clearInterval(timer)
      for (const client of wss.clients) client.terminate()
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/** One request with a raw path (never through `new URL`), answered whole. */
export const ask = (
  port: number,
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: Buffer
    host?: string
  } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false,
        ...(options.host !== undefined && { setHost: false })
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        )
        res.on('error', reject)
      }
    )
    if (options.host !== undefined) req.setHeader('host', options.host)
    req.on('error', reject)
    req.end(options.body)
  })

/** The first `event: tick` of an event stream, and how long it took; the
 *  stream is still open when it arrives, and is dropped after. */
export const firstTick = (
  port: number,
  path: string,
  headers: Record<string, string>
): Promise<{ ms: number; contentType: string | undefined }> =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const req = http.request({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let seen = ''
      res.on('data', (chunk: Buffer) => {
        seen += chunk.toString()
        if (seen.includes('event: tick')) {
          const ms = Date.now() - started
          req.destroy()
          resolve({ ms, contentType: res.headers['content-type'] })
        }
      })
      res.on('error', () => undefined)
    })
    req.on('error', (error) => {
      if (!req.destroyed) reject(error)
    })
    setTimeout(() => {
      req.destroy()
      reject(new Error('no tick within 3 s'))
    }, 3000).unref()
    req.end()
  })
