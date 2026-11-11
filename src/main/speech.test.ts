import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Folio's speech on the host (PRDCT-4411): what ElevenLabs is asked, with
// which key and voice, and how each of its answers reads. ElevenLabs is a
// stubbed `fetch`; the key is invented and never appears in an answer.
vi.mock('electron', () => {
  throw new Error('the speech host imported electron')
})
vi.mock('./exchange-digest', () => ({
  UNKNOWN_SESSION_ERROR: 'This server has no record of that session'
}))

import {
  allowedPreviewUrl,
  hostSpeech,
  SPEECH_NO_PREVIEW,
  speechRefusal,
  type SpeechIntegration
} from './speech'

const KEY = 'xi-invented-key-0000'
const BASE = 'http://elevenlabs.test'
const AUDIO = Buffer.from('ID3-fake-mp3-bytes')
const PREVIEW = 'https://storage.googleapis.com/eleven-public-prod/voice-a.mp3'

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  redirect?: RequestRedirect
}

let seen: Seen[]
let answer: (url: string) => Response | Promise<Response>
let checks: number
let clock: number

function integration(
  over: Partial<{ key: string | null; voiceId: string | null }> = {}
): SpeechIntegration {
  const key = 'key' in over ? over.key! : KEY
  const voiceId = 'voiceId' in over ? over.voiceId! : 'voice-b'
  const stub: SpeechIntegration = {
    openKey: async () => key,
    status: () => ({ voiceId, modelId: 'eleven_flash_v2_5' }),
    check: async () => {
      checks += 1
    }
  }
  return stub
}

const host = (
  over?: Parameters<typeof integration>[0],
  known = true,
  harness: string | null = null
): ReturnType<typeof hostSpeech> =>
  hostSpeech((id) => (known && id === 's1' ? {} : null), {
    integration: integration(over),
    baseUrl: () => `${BASE}/`,
    harnessBaseUrl: () => harness,
    now: () => clock
  })

beforeEach(() => {
  seen = []
  checks = 0
  clock = 1_000_000
  answer = () => new Response(AUDIO, { status: 200, headers: { 'x-character-count': '12' } })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    seen.push({
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      redirect: init.redirect
    })
    return answer(url)
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('speak', () => {
  it('posts the text with the key in its header and the chosen voice and model', async () => {
    const result = await host().speak({ sessionId: 's1', text: 'Spoken text.' })
    expect(result).toEqual({
      ok: true,
      mime: 'audio/mpeg',
      audio: AUDIO.toString('base64'),
      characters: 12
    })
    expect(seen).toEqual([
      {
        url: `${BASE}/v1/text-to-speech/voice-b?output_format=mp3_44100_128`,
        method: 'POST',
        headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: { text: 'Spoken text.', model_id: 'eleven_flash_v2_5' }
      }
    ])
  })

  it('takes the voice and model a caller names over the chosen ones', async () => {
    await host().speak({
      sessionId: 's1',
      text: 'Hi.',
      voiceId: 'voice-a',
      modelId: 'eleven_multilingual_v2'
    })
    expect(seen[0].url).toContain('/v1/text-to-speech/voice-a?')
    expect(seen[0].body).toEqual({ text: 'Hi.', model_id: 'eleven_multilingual_v2' })
  })

  it('refuses a session it has no record of, then no key, then no voice, before any call', async () => {
    expect(await host(undefined, false).speak({ sessionId: 's1', text: 'a' })).toMatchObject({
      ok: false,
      reason: 'unknown-session'
    })
    expect(await host({ key: null }).speak({ sessionId: 's1', text: 'a' })).toMatchObject({
      ok: false,
      reason: 'no-integration'
    })
    expect(await host({ voiceId: null }).speak({ sessionId: 's1', text: 'a' })).toMatchObject({
      ok: false,
      reason: 'no-voice'
    })
    expect(seen).toEqual([])
  })

  it.each([
    [401, '{"detail":{"status":"invalid_api_key"}}', 'refused'],
    [403, '', 'refused'],
    [402, '', 'quota'],
    [429, '{"detail":{"status":"quota_exceeded"}}', 'quota'],
    [429, '{"detail":{"status":"too_many_concurrent_requests"}}', 'failed'],
    [400, '{"detail":{"status":"quota_exceeded","message":"x"}}', 'quota'],
    [401, '{"detail":{"status":"quota_exceeded"}}', 'quota'],
    [400, '{"detail":{"status":"invalid"}}', 'failed'],
    [500, 'boom', 'failed']
  ] as const)('answers %i (%s) as %s, never with the key', async (status, body, reason) => {
    answer = () => new Response(body, { status })
    const result = await host().speak({ sessionId: 's1', text: 'a' })
    expect(result).toMatchObject({ ok: false, reason })
    expect(JSON.stringify(result)).not.toContain(KEY)
    if (reason === 'failed')
      expect(result).toMatchObject({ error: `ElevenLabs answered ${status}.` })
  })

  it('a stored voice id that is not a voice id makes no request (verifier round 2, S02)', async () => {
    for (const voiceId of ['../../v1/user voice', '../x', 'a/b', 'a b', 'x'.repeat(65)]) {
      const result = await host({ voiceId }).speak({ sessionId: 's1', text: 'a' })
      expect(result).toMatchObject({ ok: false, reason: 'failed' })
    }
    expect(seen).toEqual([])
  })

  it('a thrown fetch is unreachable, without the key', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error(`connect ECONNREFUSED with ${KEY}`)
    })
    const result = await host().speak({ sessionId: 's1', text: 'a' })
    expect(result).toEqual({
      ok: false,
      error: 'The server could not reach ElevenLabs.',
      reason: 'unreachable'
    })
  })

  it('reads the account again after a speak, once a minute at most', async () => {
    const speech = host()
    await speech.speak({ sessionId: 's1', text: 'a' })
    await speech.speak({ sessionId: 's1', text: 'b' })
    expect(checks).toBe(1)
    clock += 60_000
    await speech.speak({ sessionId: 's1', text: 'c' })
    expect(checks).toBe(2)
    answer = () => new Response('', { status: 500 })
    clock += 120_000
    await speech.speak({ sessionId: 's1', text: 'd' })
    expect(checks).toBe(2)
  })

  it('falls back on the text length when the service names no count', async () => {
    answer = () => new Response(AUDIO, { status: 200 })
    expect(await host().speak({ sessionId: 's1', text: 'Four' })).toMatchObject({ characters: 4 })
  })
})

describe('preview', () => {
  it("reads the voice's preview url with the key, then the sample without it", async () => {
    answer = (url) =>
      url.endsWith('/v1/voices/voice-a')
        ? Response.json({ voice_id: 'voice-a', preview_url: PREVIEW })
        : new Response(AUDIO, { status: 200 })
    const result = await host().preview('voice-a')
    expect(result).toEqual({
      ok: true,
      mime: 'audio/mpeg',
      audio: AUDIO.toString('base64'),
      characters: 0
    })
    expect(seen.map((s) => [s.url, s.headers['xi-api-key']])).toEqual([
      [`${BASE}/v1/voices/voice-a`, KEY],
      [PREVIEW, undefined]
    ])
    expect(seen[1].redirect).toBe('error')
  })

  it.each([
    'http://127.0.0.1:1/admin/secret',
    'https://10.0.0.1/x',
    'https://evil.example/x',
    'http://storage.googleapis.com/eleven-public-prod/x.mp3',
    'https://localhost/x.mp3'
  ])('never fetches a preview at %s (verifier round 2)', async (url) => {
    answer = (at) =>
      at.endsWith('/v1/voices/voice-a')
        ? Response.json({ voice_id: 'voice-a', preview_url: url })
        : new Response(AUDIO, { status: 200 })
    expect(await host().preview('voice-a')).toEqual({
      ok: false,
      error: SPEECH_NO_PREVIEW,
      reason: 'failed'
    })
    expect(seen.map((s) => s.url)).toEqual([`${BASE}/v1/voices/voice-a`])
  })

  it("fetches the harness stub's own preview, under the harness only", async () => {
    const stubPreview = `${BASE}/previews/a.mp3`
    answer = (at) =>
      at.endsWith('/v1/voices/voice-a')
        ? Response.json({ voice_id: 'voice-a', preview_url: stubPreview })
        : new Response(AUDIO, { status: 200 })
    expect(await host(undefined, true, BASE).preview('voice-a')).toMatchObject({ ok: true })
    expect(seen.at(-1)?.url).toBe(stubPreview)
    expect(await host(undefined, true, null).preview('voice-a')).toMatchObject({
      ok: false,
      error: SPEECH_NO_PREVIEW
    })
    expect(await host(undefined, true, 'http://other.test').preview('voice-a')).toMatchObject({
      ok: false,
      error: SPEECH_NO_PREVIEW
    })
  })

  it('a voice with no preview is failed; no key is no-integration; a bad id never calls', async () => {
    answer = () => Response.json({ voice_id: 'voice-a', preview_url: null })
    expect(await host().preview('voice-a')).toMatchObject({ ok: false, reason: 'failed' })
    expect(await host({ key: null }).preview('voice-a')).toMatchObject({
      ok: false,
      reason: 'no-integration'
    })
    const before = seen.length
    expect(await host().preview('../x')).toMatchObject({ ok: false, reason: 'failed' })
    expect(seen.length).toBe(before)
  })
})

describe('allowedPreviewUrl', () => {
  it.each([
    ['http://127.0.0.1:1/admin/secret', false],
    ['https://10.0.0.1/x', false],
    ['https://evil.example/x', false],
    ['https://storage.googleapis.com/eleven-public-prod/x.mp3', true],
    ['https://api.elevenlabs.io/v1/x.mp3', true],
    ['https://elevenlabs.io/x.mp3', true],
    ['https://cdn.elevenlabs.io/x.mp3', true],
    ['https://elevenlabs.io.evil.example/x.mp3', false],
    ['https://notelevenlabs.io/x.mp3', false],
    ['http://api.elevenlabs.io/x.mp3', false],
    ['https://api.elevenlabs.io:8443/x.mp3', false],
    ['https://user:pw@api.elevenlabs.io/x.mp3', false],
    ['https://storage.googleapis.com.evil.example/x.mp3', false],
    ['not a url', false],
    ['', false]
  ] as const)('%s → %s', (url, allowed) => {
    expect(allowedPreviewUrl(url)).toBe(allowed)
  })
})

describe('speechRefusal', () => {
  it('says the credits for a spent account, the key for a refused one', () => {
    expect(speechRefusal(402, '')).toMatchObject({ reason: 'quota' })
    expect(speechRefusal(401, 'nope')).toMatchObject({ reason: 'refused' })
  })
})
