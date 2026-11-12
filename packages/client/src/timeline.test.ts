import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { startEmbedded, type EmbeddedServer } from '@clave/server'
import { aSession, FakeSource } from '@clave/server/test-support'
import { SessionNotFound } from '@clave/contract/sessions'
import { TimelineReadFailed, type TimelinePage } from '@clave/contract/timeline'
import { createApiClient, type ClaveApiClient } from './api'

let server: EmbeddedServer | undefined
let old: Server | undefined
let api: ClaveApiClient | undefined
afterEach(async () => {
  await api?.dispose()
  await server?.stop()
  await new Promise((resolve) => (old ? old.close(resolve) : resolve(undefined)))
  api = server = old = undefined
})

describe('positioned history through the real client', () => {
  it('keeps positions, watermark, older-page boundary and retention, with string GET parameters', async () => {
    const page: TimelinePage = {
      items: [
        {
          event: { type: 'user_message', text: 'same' },
          position: { generation: 'g', sequence: 9 }
        }
      ],
      cursor: { generation: 'g', sequence: 12 },
      before: 9,
      truncated: true
    }
    const asked: unknown[] = []
    server = await startEmbedded({
      ports: {
        sessions: Object.assign(new FakeSource(aSession('s')), {
          timeline: (...args: unknown[]) => {
            asked.push(args)
            return page
          }
        })
      }
    })
    api = createApiClient({ url: server.url, token: server.token })
    expect(await api.sessions.timeline('s', 11, 2)).toEqual(page)
    expect(asked).toEqual([['s', 11, 2]])
    await expect(api.sessions.timeline('missing')).rejects.toBeInstanceOf(SessionNotFound)
  })

  it('uses null only for an explicitly unavailable timeline capability', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource(aSession('s')) } })
    api = createApiClient({ url: server.url, token: server.token })
    expect(await api.sessions.timeline('s')).toBeNull()
    await expect(api.sessions.timeline('missing')).rejects.toBeInstanceOf(SessionNotFound)
  })

  it('keeps a timeline read failure as an error, never legacy fallback', async () => {
    server = await startEmbedded({
      ports: {
        sessions: Object.assign(new FakeSource(aSession('s')), {
          timeline: () => {
            throw new Error('disk read failed')
          }
        })
      }
    })
    api = createApiClient({ url: server.url, token: server.token })
    await expect(api.sessions.timeline('s')).rejects.toBeInstanceOf(TimelineReadFailed)
  })

  it('recognizes the old router 404, rather than arbitrary 404 text', async () => {
    old = createServer((_req, res) =>
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'NotFound', message: 'route not found', correlationId: 'c' }))
    )
    await new Promise<void>((resolve) => old!.listen(0, '127.0.0.1', resolve))
    api = createApiClient({
      url: `http://127.0.0.1:${(old.address() as { port: number }).port}`,
      token: 't'
    })
    expect(await api.sessions.timeline('s')).toBeNull()
  })

  it.each([401, 403, 500])('does not fallback for HTTP %s', async (status) => {
    old = createServer((_req, res) => res.writeHead(status).end('failed'))
    await new Promise<void>((resolve) => old!.listen(0, '127.0.0.1', resolve))
    api = createApiClient({
      url: `http://127.0.0.1:${(old.address() as { port: number }).port}`,
      token: 't'
    })
    await expect(api.sessions.timeline('s')).rejects.toThrow()
  })

  it('does not fallback when the owner cannot be reached', async () => {
    api = createApiClient({ url: 'http://127.0.0.1:9', token: 't', timeoutMs: 100 })
    await expect(api.sessions.timeline('s')).rejects.toThrow()
  })
})
