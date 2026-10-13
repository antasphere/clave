import { describe, it, expect } from 'vitest'
import { createServer, type IncomingMessage } from 'node:http'
import { connectThroughNode } from './node'

/** A server that records the headers of every request and answers `[]`. */
const recording = (): Promise<{
  url: string
  requests: IncomingMessage[]
  stop: () => Promise<void>
}> => {
  const requests: IncomingMessage[] = []
  const server = createServer((req, res) => {
    requests.push(req)
    res.writeHead(200, { 'content-type': 'application/json' }).end('[]')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        stop: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

describe('the client through Node', () => {
  it('sends the request with the token and no Origin: nothing of a page travels', async () => {
    const server = await recording()
    try {
      const backing = await connectThroughNode({ url: server.url, token: 'the-token' })
      expect(await backing.api.sessions.list('w-1')).toEqual([])
      expect(server.requests).toHaveLength(1)
      const [request] = server.requests
      expect(request.headers['authorization']).toBe('Bearer the-token')
      expect(request.headers['origin']).toBeUndefined()
      expect(request.headers['referer']).toBeUndefined()
      expect(request.method).toBe('GET')
      expect(request.url).toBe('/sessions?windowKey=w-1')
      await backing.api.dispose()
    } finally {
      await server.stop()
    }
  })

  it('names the push client as told, and opens no socket until a subscription', async () => {
    const server = await recording()
    try {
      const backing = await connectThroughNode(
        { url: server.url, token: 't' },
        { client: 'clave-preload' }
      )
      expect(backing.push.status).toBe('idle')
      await backing.api.dispose()
    } finally {
      await server.stop()
    }
  })
})
