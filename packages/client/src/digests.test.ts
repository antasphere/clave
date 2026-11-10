import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { startEmbedded, type EmbeddedServer } from '@clave/server'
import { FakeSource } from '@clave/server/test-support'
import { type ClaveApiClient, createApiClient } from './api'
import { ServerUnreachable } from './errors'

/**
 * The digests through the typed client (PRDCT-4327): a server that answered
 * without the digests (a release before them, its router's 404; a server with
 * nothing behind the port, `CapabilityUnavailable`) reads as `outdated`, and
 * a server that did not answer stays a thrown `ServerUnreachable`, which the
 * card says as "the server did not answer".
 */
let server: EmbeddedServer | undefined
let old: Server | undefined
let api: ClaveApiClient | undefined
afterEach(async () => {
  await api?.dispose()
  await server?.stop()
  await new Promise((resolve) => (old ? old.close(resolve) : resolve(undefined)))
  api = server = old = undefined
})

const read = { sessionId: 's', key: '1-x', messages: [{ from: 'a', text: 'b' }] }

describe('the digests of the client', () => {
  it('a server with nothing behind the port reads as outdated', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    api = createApiClient({ url: server.url, token: server.token })
    await expect(api.digests.exchange(read)).resolves.toMatchObject({
      ok: false,
      reason: 'outdated'
    })
    await expect(
      api.digests.work({ sessionId: 's', key: 'work-1-x', notes: ['n'], tools: 0 })
    ).resolves.toMatchObject({ ok: false, reason: 'outdated' })
    await expect(api.digests.exchangesOf('s')).resolves.toEqual({})
    await expect(api.digests.workOf('s')).resolves.toEqual({})
  })

  it("an older server's 404 reads as outdated", async () => {
    old = createServer((_request, response) => {
      response
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'NotFound', message: 'route not found', correlationId: 'c' }))
    })
    await new Promise<void>((resolve) => old!.listen(0, '127.0.0.1', resolve))
    const { port } = old.address() as { port: number }
    api = createApiClient({ url: `http://127.0.0.1:${port}`, token: 't' })
    await expect(api.digests.exchange(read)).resolves.toMatchObject({
      ok: false,
      reason: 'outdated'
    })
    await expect(api.digests.exchangesOf('s')).resolves.toEqual({})
  })

  it('a server that does not answer is still thrown, not outdated', async () => {
    api = createApiClient({ url: 'http://127.0.0.1:9', token: 't', timeoutMs: 2_000 })
    await expect(api.digests.exchange(read)).rejects.toBeInstanceOf(ServerUnreachable)
  })

  it('a request the server refuses as invalid (400) reads as failed, never as unanswered', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    api = createApiClient({ url: server.url, token: server.token })
    await expect(
      api.digests.exchange({ sessionId: 's', key: 'not-a-key', messages: [] })
    ).resolves.toMatchObject({ ok: false, reason: 'failed' })
    await expect(
      api.digests.work({ sessionId: 's', key: '1-x', notes: [], tools: 0 })
    ).resolves.toMatchObject({ ok: false, reason: 'failed' })
  })
})
