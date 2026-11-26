import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { startEmbedded, type EmbeddedServer } from '@clave/server'
import { FakeSource } from '@clave/server/test-support'
import { type ClaveApiClient, createApiClient } from './api'
import { ServerUnreachable } from './errors'
import { DecisionsMissing } from './decisions'

/**
 * The decisions through the typed client (PRDCT-5179): a server that
 * answered without them (an older release's 404, nothing behind the port) is
 * thrown as `DecisionsMissing`; a server that did not answer stays a thrown
 * `ServerUnreachable`; an answer of the port comes back as it is.
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

describe('the decisions of the client', () => {
  it('answers what the port answered, without what the host keeps to itself', async () => {
    server = await startEmbedded({
      ports: {
        sessions: new FakeSource(),
        decisions: {
          readTabProjects: async (ids) =>
            ids.map((sessionId) => ({
              sessionId,
              projects: null,
              reason: 'no-key' as const,
              written: false
            }))
        }
      }
    })
    api = createApiClient({ url: server.url, token: server.token })
    expect(await api.decisions.readTabProjects(['a', 'b'])).toEqual({
      tabs: [
        { sessionId: 'a', projects: null, reason: 'no-key' },
        { sessionId: 'b', projects: null, reason: 'no-key' }
      ]
    })
  })

  it('a server with nothing behind the port is thrown as missing', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    api = createApiClient({ url: server.url, token: server.token })
    await expect(api.decisions.readTabProjects(['a'])).rejects.toBeInstanceOf(DecisionsMissing)
  })

  it("an older server's 404 is thrown as missing", async () => {
    old = createServer((_request, response) => {
      response
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'NotFound', message: 'route not found', correlationId: 'c' }))
    })
    await new Promise<void>((resolve) => old!.listen(0, '127.0.0.1', resolve))
    const { port } = old.address() as { port: number }
    api = createApiClient({ url: `http://127.0.0.1:${port}`, token: 't' })
    await expect(api.decisions.readTabProjects(['a'])).rejects.toBeInstanceOf(DecisionsMissing)
  })

  it('a server that does not answer is still thrown, not missing', async () => {
    api = createApiClient({ url: 'http://127.0.0.1:9', token: 't', timeoutMs: 2_000 })
    await expect(api.decisions.readTabProjects(['a'])).rejects.toBeInstanceOf(ServerUnreachable)
  })
})
