import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { startEmbedded, type EmbeddedServer } from '@clave/server'
import { FakeSource } from '@clave/server/test-support'
import { type ClaveApiClient, createApiClient } from './api'
import { ServerUnreachable } from './errors'

/**
 * The speech through the typed client (PRDCT-4411): a server that answered
 * without the speech (an older release's 404, nothing behind the port) reads
 * as `outdated`; a request it refuses as invalid reads as `failed`; a server
 * that did not answer stays a thrown `ServerUnreachable`; an answer of the
 * port comes back as it is.
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

describe('the speech of the client', () => {
  it('a server with nothing behind the port reads as outdated', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    api = createApiClient({ url: server.url, token: server.token })
    await expect(api.speech.speak({ sessionId: 's', text: 'Hello.' })).resolves.toMatchObject({
      ok: false,
      reason: 'outdated'
    })
    await expect(api.speech.preview({ voiceId: 'v1' })).resolves.toMatchObject({
      ok: false,
      reason: 'outdated'
    })
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
    await expect(api.speech.speak({ sessionId: 's', text: 'Hello.' })).resolves.toMatchObject({
      ok: false,
      reason: 'outdated'
    })
  })

  it('a server that does not answer is still thrown, not outdated', async () => {
    api = createApiClient({ url: 'http://127.0.0.1:9', token: 't', timeoutMs: 2_000 })
    await expect(api.speech.speak({ sessionId: 's', text: 'Hello.' })).rejects.toBeInstanceOf(
      ServerUnreachable
    )
  })

  it('a request refused as invalid reads as failed; an answer comes back whole', async () => {
    const asked: unknown[] = []
    server = await startEmbedded({
      ports: {
        sessions: new FakeSource(),
        speech: {
          speak: async (request) => {
            asked.push(request)
            return request.text === 'quota'
              ? { ok: false, error: 'The ElevenLabs credits are spent.', reason: 'quota' }
              : { ok: true, mime: 'audio/mpeg', audio: 'AAAA', characters: request.text.length }
          },
          preview: async () => ({ ok: true, mime: 'audio/mpeg', audio: 'BBBB', characters: 0 })
        }
      }
    })
    api = createApiClient({ url: server.url, token: server.token })
    await expect(api.speech.speak({ sessionId: 's', text: '' })).resolves.toMatchObject({
      ok: false,
      reason: 'failed'
    })
    await expect(
      api.speech.speak({ sessionId: 's', text: 'x'.repeat(5_001) })
    ).resolves.toMatchObject({ ok: false, reason: 'failed' })
    await expect(api.speech.preview({ voiceId: '../etc' })).resolves.toMatchObject({
      ok: false,
      reason: 'failed'
    })
    expect(asked).toEqual([])
    await expect(api.speech.speak({ sessionId: 's', text: 'Hello.' })).resolves.toEqual({
      ok: true,
      mime: 'audio/mpeg',
      audio: 'AAAA',
      characters: 6
    })
    await expect(api.speech.speak({ sessionId: 's', text: 'quota' })).resolves.toEqual({
      ok: false,
      error: 'The ElevenLabs credits are spent.',
      reason: 'quota'
    })
    await expect(api.speech.preview({ voiceId: 'v1' })).resolves.toMatchObject({
      ok: true,
      audio: 'BBBB'
    })
    expect(asked).toEqual([
      { sessionId: 's', text: 'Hello.' },
      { sessionId: 's', text: 'quota' }
    ])
  })
})
