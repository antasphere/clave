import { afterEach, describe, expect, it } from 'vitest'
import { SPEECH_MAX_TEXT, type SpeakRequest } from '@clave/contract/speech'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource } from '../test-support'
import type { SpeechService } from './port'
import { SPEECH_BODY_LIMIT } from '../runtime'

/**
 * The speech domain (PRDCT-4411): a client asks the server a tab runs on,
 * behind the bearer token; the request reaches the port without any field
 * the contract does not name; speech that could not be made is an answer
 * with its reason; a server with nothing behind the port says so.
 */
let server: EmbeddedServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

const call = (path: string, body: unknown, token = server!.token): Promise<Response> =>
  fetch(`${server!.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

function fakePort(): { port: SpeechService; asked: unknown[] } {
  const asked: unknown[] = []
  const port: SpeechService = {
    speak: async (request: SpeakRequest) => {
      asked.push(request)
      return request.text === 'no key'
        ? { ok: false, error: 'No ElevenLabs key on this server.', reason: 'no-integration' }
        : { ok: true, mime: 'audio/mpeg', audio: 'AAAA', characters: request.text.length }
    },
    preview: async (voiceId) => {
      asked.push({ preview: voiceId })
      return { ok: true, mime: 'audio/mpeg', audio: 'BBBB', characters: 0 }
    }
  }
  return { port, asked }
}

describe('the speech over HTTP', () => {
  it('speaks for a session with only the fields the contract names', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), speech: port } })
    const answer = await call('/speech/speak', {
      sessionId: 's1',
      text: 'Spoken text.',
      apiKey: 'a-client-key'
    })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({
      ok: true,
      mime: 'audio/mpeg',
      audio: 'AAAA',
      characters: 12
    })
    const voiced = await call('/speech/speak', {
      sessionId: 's1',
      text: 'Hi.',
      voiceId: 'voice-b',
      modelId: 'eleven_multilingual_v2'
    })
    expect(voiced.status).toBe(200)
    const preview = await call('/speech/preview', { voiceId: 'voice-a' })
    expect(await preview.json()).toMatchObject({ ok: true, audio: 'BBBB' })
    expect(asked).toEqual([
      { sessionId: 's1', text: 'Spoken text.' },
      { sessionId: 's1', text: 'Hi.', voiceId: 'voice-b', modelId: 'eleven_multilingual_v2' },
      { preview: 'voice-a' }
    ])
  })

  it('speech that could not be made is an answer with its reason', async () => {
    const { port } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), speech: port } })
    const answer = await call('/speech/speak', { sessionId: 's1', text: 'no key' })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({
      ok: false,
      error: 'No ElevenLabs key on this server.',
      reason: 'no-integration'
    })
  })

  it('refuses, before the port, a text past its bound, an empty one, a foreign voice or model', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), speech: port } })
    const status = (path: string, body: object): Promise<number> =>
      call(path, body).then((r) => r.status)
    expect(
      await status('/speech/speak', { sessionId: 's1', text: 't'.repeat(SPEECH_MAX_TEXT + 1) })
    ).toBe(400)
    expect(await status('/speech/speak', { sessionId: 's1', text: '' })).toBe(400)
    expect(await status('/speech/speak', { sessionId: '', text: 'a' })).toBe(400)
    expect(await status('/speech/speak', { sessionId: 's1', text: 'a', voiceId: '../x' })).toBe(400)
    expect(
      await status('/speech/speak', { sessionId: 's1', text: 'a', modelId: 'eleven_v9' })
    ).toBe(400)
    expect(await status('/speech/preview', { voiceId: 'a/b' })).toBe(400)
    expect(asked).toEqual([])
    expect(
      await status('/speech/speak', { sessionId: 's1', text: 't'.repeat(SPEECH_MAX_TEXT) })
    ).toBe(200)
  })

  it('reads no body past 64 KB', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), speech: port } })
    const answer = await call('/speech/speak', {
      sessionId: 's1',
      text: 'a',
      pad: 'p'.repeat(SPEECH_BODY_LIMIT)
    })
    expect(answer.status).toBe(413)
    expect(asked).toEqual([])
  })

  it('refuses without the token, and says so on a server with no speech', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    expect((await call('/speech/speak', { sessionId: 's1', text: 'a' }, 'wrong')).status).toBe(401)
    for (const [path, body] of [
      ['/speech/speak', { sessionId: 's1', text: 'a' }],
      ['/speech/preview', { voiceId: 'v1' }]
    ] as const) {
      const answer = await call(path, body)
      expect(answer.status).toBe(422)
      expect(await answer.json()).toMatchObject({
        _tag: 'CapabilityUnavailable',
        capability: 'speech'
      })
    }
  })
})
