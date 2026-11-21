import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  throw new Error('the integrations store imported electron')
})

import { electronTestPorts, standaloneTestPorts } from '../ports/testing'
import type { SettingsPorts } from '../ports/registry'
import {
  cleanReason,
  ELEVENLABS_PERMISSION_HINT,
  ElevenLabsIntegration,
  elevenLabsBaseUrl,
  elevenLabsBaseUrlOverride,
  INTEGRATIONS_FILE,
  KEY_CHECK_VOICE,
  keyRefused,
  refusedSentence,
  serviceDetail
} from './elevenlabs'

// The ElevenLabs integration on the host (PRDCT-4410): the key is sealed by
// the machine's secret port and appears in no document and no status; the
// key check (the voices, the speech, the account beside them: PRDCT-4831)
// and the voices are read from a stubbed `fetch`, never the service. Every
// key here is invented; the refusals' bodies are ElevenLabs' own, as it
// answered a key restricted on its website on 21 November 2026.

const KEY = 'xi-unit-test-key-0001'
const BASE = 'http://elevenlabs.test'

type Answer =
  | { status: number; body?: unknown }
  | 'throw'
  | Promise<{ status: number; body?: unknown }>
let answers: Map<string, Answer[]>
let requests: { url: string; key: string | null; method: string; body: unknown }[]

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      requests.push({
        url: input,
        key: headers.get('xi-api-key'),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null
      })
      const pathname = new URL(input).pathname
      const queue = answers.get(pathname) ?? []
      const queued = queue.length > 1 ? queue.shift()! : queue[0]
      const answer = queued instanceof Promise ? await queued : queued
      if (!answer || answer === 'throw') throw new TypeError('fetch failed')
      return new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status,
        headers: { 'content-type': 'application/json' }
      })
    })
  )
}

const subscription = {
  status: 200,
  body: { tier: 'creator', character_count: 1200, character_limit: 100000, status: 'active' }
}

/** ElevenLabs' refusal of a key without one permission, verbatim. */
const missing = (permission: string): { status: number; body: unknown } => ({
  status: 401,
  body: {
    detail: {
      type: 'authentication_error',
      code: 'unauthorized',
      message: `The API key you used is missing the permission ${permission} to execute this operation.`,
      status: 'missing_permissions',
      request_id: '082b022b334a7d916d575e4f7aed45b4'
    }
  }
})
/** ElevenLabs' answer to a key that is not a key, verbatim (a 400). */
const invalidKey = {
  status: 400,
  body: {
    detail: {
      type: 'authentication_error',
      code: 'invalid_api_key',
      message: 'API key is invalid.',
      status: 'invalid_api_key',
      request_id: 'a9de363a6c2c13a517c948bc6a62e31f',
      param: 'api_key'
    }
  }
}
const SPEECH_PROBE = `/v1/text-to-speech/${KEY_CHECK_VOICE}`
/** What ElevenLabs answers a key allowed to speak, asked for a voice no
 *  account has. */
const voiceNotFound = {
  status: 404,
  body: {
    detail: {
      type: 'not_found',
      code: 'voice_not_found',
      message: `A voice with voice_id '${KEY_CHECK_VOICE}' was not found.`,
      status: 'voice_not_found'
    }
  }
}
const someVoices = { status: 200, body: { voices: [], has_more: false } }

const fileText = (ports: { dir: string }): string =>
  fs.readFileSync(path.join(ports.dir, INTEGRATIONS_FILE), 'utf-8')

beforeEach(() => {
  answers = new Map<string, Answer[]>([
    ['/v1/user/subscription', [subscription]],
    ['/v2/voices', [someVoices]],
    [SPEECH_PROBE, [voiceNotFound]]
  ])
  requests = []
  stubFetch()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each([
  ['the Electron adapters', () => electronTestPorts()],
  ['the standalone adapters', () => standaloneTestPorts()]
] as const)('on %s', (_name, make) => {
  let ports: SettingsPorts & { dir: string }
  let integration: ElevenLabsIntegration
  beforeEach(() => {
    ports = make()
    integration = new ElevenLabsIntegration(ports, { baseUrl: () => BASE, now: () => 1000 })
  })

  it('stores the key sealed: never in the document, never in the status', async () => {
    const status = await integration.setKey(`  ${KEY}\n`)
    expect(status).toMatchObject({
      configured: true,
      setAt: 1000,
      tier: 'creator',
      charactersUsed: 1200,
      charactersLimit: 100000,
      checkedAt: 1000,
      lastError: null,
      modelId: 'eleven_flash_v2_5'
    })
    expect(JSON.stringify(status)).not.toContain(KEY)
    expect(fileText(ports)).not.toContain(KEY)
    expect(JSON.stringify(integration.status())).not.toContain(KEY)
    expect(await integration.openKey()).toBe(KEY)
    expect(requests).toContainEqual({
      url: `${BASE}/v1/user/subscription`,
      key: KEY,
      method: 'GET',
      body: null
    })
  })

  it('checks what Folio uses: the voices, and the speech on a voice no account has', async () => {
    await integration.setKey(KEY)
    const voices = requests.find((r) => r.url.startsWith(`${BASE}/v2/voices`))
    expect(voices).toMatchObject({ key: KEY, method: 'GET' })
    const speech = requests.find((r) => r.url.startsWith(`${BASE}${SPEECH_PROBE}`))
    expect(speech).toMatchObject({ key: KEY, method: 'POST' })
    expect(speech?.body).toMatchObject({ text: 'a' })
    // Nothing is asked of a real voice: the check never makes audio.
    expect(requests.filter((r) => r.url.includes('/v1/text-to-speech/'))).toHaveLength(1)
  })

  it('a key that may not read the account is a good key: no plan, no credits, no error (PRDCT-4831)', async () => {
    answers.set('/v1/user/subscription', [missing('user_read')])
    const status = await integration.setKey(KEY)
    expect(status).toMatchObject({
      configured: true,
      checkedAt: 1000,
      lastError: null,
      tier: null,
      charactersUsed: null,
      charactersLimit: null
    })
    // A key that could read the account and no longer can: the old figures go.
    answers.set('/v1/user/subscription', [subscription])
    expect((await integration.check()).tier).toBe('creator')
    answers.set('/v1/user/subscription', [missing('user_read')])
    expect(await integration.check()).toMatchObject({
      lastError: null,
      tier: null,
      charactersUsed: null
    })
  })

  it("a key that may not read the voices is refused in ElevenLabs' words, with where to fix it", async () => {
    answers.set('/v1/user/subscription', [missing('user_read')])
    answers.set('/v2/voices', [missing('voices_read')])
    const status = await integration.setKey(KEY)
    expect(status.configured).toBe(true)
    expect(status.lastError).toBe(
      'ElevenLabs refused the key: The API key you used is missing the permission voices_read to execute this operation. ' +
        ELEVENLABS_PERMISSION_HINT
    )
    expect(await integration.openKey()).toBe(KEY)
  })

  it("a key that may not speak is refused in ElevenLabs' words", async () => {
    answers.set(SPEECH_PROBE, [missing('text_to_speech')])
    const status = await integration.setKey(KEY)
    expect(status.lastError).toContain('missing the permission text_to_speech')
    expect(status.lastError).toContain(ELEVENLABS_PERMISSION_HINT)
  })

  it('the speech is past the key on any answer but a refusal of it', async () => {
    for (const answer of [
      voiceNotFound,
      { status: 404 },
      { status: 400, body: { detail: [{ msg: 'field required' }] } },
      { status: 500 },
      { status: 401, body: { detail: { status: 'quota_exceeded', message: 'quota' } } }
    ]) {
      answers.set(SPEECH_PROBE, [answer])
      expect((await integration.setKey(KEY)).lastError).toBeNull()
    }
  })

  it('an invalid key is refused, as a 400 as ElevenLabs answers it today and as a 401', async () => {
    for (const where of ['/v2/voices', SPEECH_PROBE]) {
      answers.set(where, [invalidKey])
      expect((await integration.setKey(KEY)).lastError).toBe(
        'ElevenLabs refused the key: API key is invalid.'
      )
      answers.set(where, where === SPEECH_PROBE ? [voiceNotFound] : [someVoices])
    }
    answers.set('/v2/voices', [{ status: 401, body: { detail: { status: 'invalid_api_key' } } }])
    expect((await integration.check()).lastError).toBe('The key was refused by ElevenLabs.')
    answers.set('/v2/voices', [{ status: 403 }])
    expect((await integration.check()).lastError).toBe('The key was refused by ElevenLabs.')
  })

  it('the reason never carries the key, wherever ElevenLabs puts it', async () => {
    answers.set('/v2/voices', [
      {
        status: 401,
        body: {
          detail: { message: `The key ${KEY} is not allowed\nhere; sk_${'ab12'.repeat(12)}` }
        }
      }
    ])
    const status = await integration.setKey(KEY)
    expect(status.lastError).toBe('ElevenLabs refused the key: The key … is not allowed here; …')
    expect(JSON.stringify(status)).not.toContain(KEY)
    expect(JSON.stringify(status)).not.toContain('ab12ab12')
    expect(fileText(ports)).not.toContain(KEY)
    expect(JSON.stringify(integration.status())).not.toContain(KEY)
  })

  it('another status of the voices is named, and a network failure keeps the paste', async () => {
    answers.set('/v2/voices', [{ status: 500 }])
    expect((await integration.setKey(KEY)).lastError).toBe('ElevenLabs answered 500.')
    answers.set('/v2/voices', ['throw'])
    const status = await integration.check()
    expect(status.lastError).toBe('The server could not reach ElevenLabs.')
    expect(status.configured).toBe(true)
    expect(JSON.stringify(status)).not.toContain(KEY)
    answers.set('/v2/voices', [someVoices])
    answers.set(SPEECH_PROBE, ['throw'])
    expect((await integration.check()).lastError).toBe('The server could not reach ElevenLabs.')
    answers.set(SPEECH_PROBE, [voiceNotFound])
    // The account alone failing to answer: the key is good, the last figures stay.
    expect((await integration.check()).tier).toBe('creator')
    for (const down of ['throw', { status: 500 }] as const) {
      answers.set('/v1/user/subscription', [down])
      expect(await integration.check()).toMatchObject({
        lastError: null,
        tier: 'creator',
        charactersUsed: 1200
      })
    }
  })

  it('refreshes the account alone after a speak: its figures, none once the key may not read them', async () => {
    await integration.setKey(KEY)
    await integration.setVoice('v1', 'Voice 1')
    const asked = requests.length
    answers.set('/v1/user/subscription', [
      { status: 200, body: { tier: 'pro', character_count: 5, character_limit: 10 } }
    ])
    expect(await integration.refreshAccount()).toMatchObject({
      tier: 'pro',
      charactersUsed: 5,
      charactersLimit: 10,
      voiceId: 'v1',
      lastError: null
    })
    expect(requests.slice(asked).map((r) => new URL(r.url).pathname)).toEqual([
      '/v1/user/subscription'
    ])
    // A failure to answer, or the same figures again: no write, no event.
    const before = fileText(ports)
    const seen: unknown[] = []
    integration.onChange((status) => seen.push(status))
    answers.set('/v1/user/subscription', ['throw'])
    expect((await integration.refreshAccount()).tier).toBe('pro')
    answers.set('/v1/user/subscription', [
      { status: 200, body: { tier: 'pro', character_count: 5, character_limit: 10 } }
    ])
    await integration.refreshAccount()
    expect(fileText(ports)).toBe(before)
    expect(seen).toHaveLength(0)
    // The key lost the permission on the website: the figures go, the key stays good.
    answers.set('/v1/user/subscription', [missing('user_read')])
    expect(await integration.refreshAccount()).toMatchObject({
      tier: null,
      charactersUsed: null,
      charactersLimit: null,
      lastError: null,
      checkedAt: 1000,
      voiceId: 'v1'
    })
    expect(seen).toHaveLength(1)
    // And a refresh never writes a check's verdict.
    answers.set('/v2/voices', [missing('voices_read')])
    await integration.check()
    const refused = integration.status().lastError
    answers.set('/v1/user/subscription', [subscription])
    expect(await integration.refreshAccount()).toMatchObject({
      tier: 'creator',
      lastError: refused
    })
  })

  it('a refresh never writes over a Remove or a Replace made meanwhile', async () => {
    await integration.setKey(KEY)
    const hold = heldSubscription()
    const refreshing = integration.refreshAccount()
    await hold.asked
    await integration.removeKey()
    hold.release()
    expect((await refreshing).configured).toBe(false)
    expect(integration.status().configured).toBe(false)
  })

  it('reads the voices page by page', async () => {
    await integration.setKey(KEY)
    const asked = requests.length
    const voice = (n: number): Record<string, unknown> => ({
      voice_id: `v${n}`,
      name: `Voice ${n}`,
      category: 'premade',
      labels: { accent: 'neutral', age: '' },
      preview_url: n === 1 ? 'https://example.test/v1.mp3' : null
    })
    answers.set('/v2/voices', [
      {
        status: 200,
        body: { voices: [voice(1), voice(2)], has_more: true, next_page_token: 't2' }
      },
      { status: 200, body: { voices: [voice(3)], has_more: false, next_page_token: null } }
    ])
    const { voices } = await integration.voices()
    expect(voices.map((v) => v.voiceId)).toEqual(['v1', 'v2', 'v3'])
    expect(voices[0]).toEqual({
      voiceId: 'v1',
      name: 'Voice 1',
      category: 'premade',
      labels: { accent: 'neutral' },
      previewUrl: 'https://example.test/v1.mp3'
    })
    const voiceCalls = requests.slice(asked).filter((r) => r.url.includes('/v2/voices'))
    expect(voiceCalls).toHaveLength(2)
    expect(voiceCalls[0].url).toContain('page_size=100')
    expect(voiceCalls[1].url).toContain('next_page_token=t2')
  })

  it('caps the voices at 500', async () => {
    await integration.setKey(KEY)
    let n = 0
    const page = (): Record<string, unknown> => ({
      voices: Array.from({ length: 100 }, () => ({ voice_id: `v${n++}`, name: 'v' })),
      has_more: true,
      next_page_token: `t${n}`
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(page()), { status: 200 }))
    )
    expect((await integration.voices()).voices).toHaveLength(500)
  })

  it('refuses the voices in the check words', async () => {
    await expect(integration.voices()).rejects.toThrow('No ElevenLabs key on this machine.')
    await integration.setKey(KEY)
    answers.set('/v2/voices', [{ status: 401 }])
    await expect(integration.voices()).rejects.toThrow('The key was refused by ElevenLabs.')
    answers.set('/v2/voices', [missing('voices_read')])
    await expect(integration.voices()).rejects.toThrow(
      'ElevenLabs refused the key: The API key you used is missing the permission voices_read'
    )
    answers.set('/v2/voices', [{ status: 429 }])
    await expect(integration.voices()).rejects.toThrow('ElevenLabs answered 429.')
    answers.set('/v2/voices', ['throw'])
    await expect(integration.voices()).rejects.toThrow('The server could not reach ElevenLabs.')
  })

  it('stores the voice and the model; a new key keeps the model and clears the voice', async () => {
    await integration.setKey(KEY)
    const status = await integration.setVoice('v1', 'Voice 1', 'eleven_multilingual_v2')
    expect(status).toMatchObject({
      voiceId: 'v1',
      voiceName: 'Voice 1',
      modelId: 'eleven_multilingual_v2'
    })
    expect(integration.status().voiceId).toBe('v1')
    await expect(integration.setVoice('v1', 'Voice 1', 'eleven_v3' as never)).rejects.toThrow(
      'That is not an ElevenLabs model.'
    )
    const replaced = await integration.setKey('xi-unit-test-key-0002')
    expect(replaced).toMatchObject({ voiceId: null, modelId: 'eleven_multilingual_v2' })
  })

  it('remove discards the sealed handle and deletes the entry', async () => {
    const discard = vi.spyOn(ports.secrets, 'discard')
    await integration.setKey(KEY)
    const sealed = JSON.parse(fileText(ports)).elevenLabs.sealed as string
    const status = await integration.removeKey()
    expect(status.configured).toBe(false)
    expect(discard).toHaveBeenCalledWith(sealed)
    expect(JSON.parse(fileText(ports))).toEqual({ version: 1 })
    expect(await integration.openKey()).toBeNull()
  })

  it('a replaced key discards the old handle', async () => {
    const discard = vi.spyOn(ports.secrets, 'discard')
    await integration.setKey(KEY)
    const first = JSON.parse(fileText(ports)).elevenLabs.sealed as string
    await integration.setKey('xi-unit-test-key-0002')
    expect(discard).toHaveBeenCalledWith(first)
    expect(await integration.openKey()).toBe('xi-unit-test-key-0002')
  })

  // ── A check in flight never undoes a Remove or a Replace (verifier round 2) ──

  /** An account answer held until the test lets it go. */
  function heldSubscription(): { release: () => void; asked: Promise<void> } {
    let release!: () => void
    const held = new Promise<{ status: number; body?: unknown }>((resolve) => {
      release = () => resolve({ status: 200, body: { ...subscription.body, tier: 'held' } })
    })
    let asked!: () => void
    const wasAsked = new Promise<void>((resolve) => (asked = resolve))
    answers.set('/v1/user/subscription', [held])
    const before = requests.length
    const poll = setInterval(() => {
      if (requests.length > before) {
        clearInterval(poll)
        asked()
      }
    }, 1)
    return { release, asked: wasAsked }
  }

  const sealedOf = (): string | undefined => {
    const text = fs.existsSync(path.join(ports.dir, INTEGRATIONS_FILE)) ? fileText(ports) : '{}'
    return (JSON.parse(text) as { elevenLabs?: { sealed: string } }).elevenLabs?.sealed
  }

  it('Remove during a check leaves no entry, and the check writes nothing back', async () => {
    const discard = vi.spyOn(ports.secrets, 'discard')
    await integration.setKey(KEY)
    const first = sealedOf()!
    const hold = heldSubscription()
    const checking = integration.check()
    await hold.asked
    const removed = await integration.removeKey()
    expect(removed.configured).toBe(false)
    hold.release()
    const checked = await checking
    expect(checked.configured).toBe(false)
    expect(integration.status().configured).toBe(false)
    expect(sealedOf()).toBeUndefined()
    expect(await integration.openKey()).toBeNull()
    expect(discard).toHaveBeenCalledWith(first)
    if ('security' in ports)
      expect((ports as { security: { items: Map<string, string> } }).security.items.size).toBe(0)
  })

  it('Replace during a check leaves the new key, the old handle discarded', async () => {
    const discard = vi.spyOn(ports.secrets, 'discard')
    await integration.setKey(KEY)
    const first = sealedOf()!
    const hold = heldSubscription()
    const checking = integration.check()
    await hold.asked
    answers.set('/v1/user/subscription', [subscription])
    await integration.setKey('xi-unit-test-key-0002')
    const second = sealedOf()!
    expect(second).not.toBe(first)
    hold.release()
    const checked = await checking
    expect(checked.tier).toBe('creator')
    expect(integration.status().tier).toBe('creator')
    expect(sealedOf()).toBe(second)
    expect(await integration.openKey()).toBe('xi-unit-test-key-0002')
    expect(discard).toHaveBeenCalledWith(first)
    expect(discard).not.toHaveBeenCalledWith(second)
    if ('security' in ports)
      expect((ports as { security: { items: Map<string, string> } }).security.items.size).toBe(1)
  })

  it('the key replaced during a setKey check: the first setKey answers the new entry', async () => {
    const hold = heldSubscription()
    const saving = integration.setKey(KEY)
    await hold.asked
    answers.set('/v1/user/subscription', [subscription])
    await integration.setKey('xi-unit-test-key-0002')
    hold.release()
    await saving
    expect(await integration.openKey()).toBe('xi-unit-test-key-0002')
  })

  it('a check that returns to an unchanged entry records its fields, and keeps a voice set meanwhile', async () => {
    answers.set('/v2/voices', [{ status: 500 }])
    await integration.setKey(KEY)
    expect(integration.status().lastError).toBe('ElevenLabs answered 500.')
    answers.set('/v2/voices', [someVoices])
    const hold = heldSubscription()
    const checking = integration.check()
    await hold.asked
    await integration.setVoice('v1', 'Voice 1')
    hold.release()
    const status = await checking
    expect(status).toMatchObject({
      configured: true,
      tier: 'held',
      charactersUsed: 1200,
      charactersLimit: 100000,
      lastError: null,
      checkedAt: 1000,
      voiceId: 'v1'
    })
    expect(integration.status()).toEqual(status)
  })

  it('writes one after the other: a write waits for the one before it to finish', async () => {
    await integration.setKey(KEY)
    const discard = ports.secrets.discard.bind(ports.secrets)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(ports.secrets, 'discard').mockImplementationOnce(async (sealed) => {
      await held
      await discard(sealed)
    })
    const removing = integration.removeKey()
    const setting = integration.setKey('xi-unit-test-key-0002')
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
    // The removal is still discarding: the new key is not written yet.
    expect(sealedOf()).toBeUndefined()
    release()
    await removing
    await setting
    expect(await integration.openKey()).toBe('xi-unit-test-key-0002')
  })

  it('a save that fails after sealing discards the new handle and keeps the previous entry (I05)', async () => {
    await integration.setKey(KEY)
    const before = fileText(ports)
    const discard = vi.spyOn(ports.secrets, 'discard')
    const seal = vi.spyOn(ports.secrets, 'seal')
    vi.spyOn(ports.storage, 'write').mockImplementation(() => {
      throw new Error('disk full')
    })
    await expect(integration.setKey('xi-unit-test-key-0002')).rejects.toThrow('disk full')
    const sealed = await seal.mock.results[0].value
    expect(discard).toHaveBeenCalledWith(sealed)
    expect(discard).toHaveBeenCalledTimes(1)
    expect(fileText(ports)).toBe(before)
    expect(await integration.openKey()).toBe(KEY)
    if ('security' in ports)
      expect((ports as { security: { items: Map<string, string> } }).security.items.size).toBe(1)
  })

  it('emits the status after each write, never the key', async () => {
    const seen: string[] = []
    integration.onChange((status) => seen.push(JSON.stringify(status)))
    await integration.setKey(KEY)
    await integration.setVoice('v1', 'Voice 1')
    await integration.removeKey()
    expect(seen.length).toBeGreaterThanOrEqual(3)
    for (const status of seen) expect(status).not.toContain(KEY)
  })
})

describe('refusals', () => {
  it('an empty paste is refused', async () => {
    const integration = new ElevenLabsIntegration(electronTestPorts(), { baseUrl: () => BASE })
    await expect(integration.setKey('   ')).rejects.toThrow('Paste the API key first.')
  })

  it('an unavailable secret port refuses, and nothing is stored', async () => {
    const ports = electronTestPorts(undefined, { available: false })
    const integration = new ElevenLabsIntegration(ports, { baseUrl: () => BASE })
    await expect(integration.setKey(KEY)).rejects.toThrow('This machine cannot store a secret.')
    expect(fs.existsSync(path.join(ports.dir, INTEGRATIONS_FILE))).toBe(false)
    expect(integration.status().configured).toBe(false)
  })

  it('reads a half-written document as far as it is well formed', () => {
    const ports = electronTestPorts()
    fs.writeFileSync(path.join(ports.dir, INTEGRATIONS_FILE), '{"version":1,"elevenLabs":{')
    const integration = new ElevenLabsIntegration(ports, { baseUrl: () => BASE })
    expect(integration.status().configured).toBe(false)
    fs.writeFileSync(
      path.join(ports.dir, INTEGRATIONS_FILE),
      JSON.stringify({ version: 1, elevenLabs: { sealed: 'h', modelId: 'nope', tier: 7 } })
    )
    expect(integration.status()).toMatchObject({
      configured: true,
      modelId: 'eleven_flash_v2_5',
      tier: null
    })
  })

  it('the base URL variable is ignored outside the test harness (verifier round 2)', async () => {
    vi.stubEnv('CLAVE_ELEVENLABS_BASE_URL', 'http://from-env.test/')
    try {
      expect(elevenLabsBaseUrl()).toBe('https://api.elevenlabs.io')
      const integration = new ElevenLabsIntegration(electronTestPorts())
      await integration.setKey(KEY)
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests)
        expect(request.url).toMatch(/^https:\/\/api\.elevenlabs\.io\//)
      expect(requests.map((r) => r.url)).toContain('https://api.elevenlabs.io/v1/user/subscription')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('the base URL variable is honoured under the harness only, with no escape hatch (verifier round 3)', () => {
    const named = { CLAVE_ELEVENLABS_BASE_URL: ' http://from-env.test/ ' }
    expect(elevenLabsBaseUrlOverride(named, false)).toBeNull()
    expect(elevenLabsBaseUrlOverride(named, true)).toBe('http://from-env.test/')
    // The old allow variable opens nothing any more.
    for (const allow of ['1', 'true'])
      expect(
        elevenLabsBaseUrlOverride({ ...named, CLAVE_ELEVENLABS_ALLOW_BASE_URL: allow }, false)
      ).toBeNull()
    expect(elevenLabsBaseUrlOverride({}, true)).toBeNull()
    vi.stubEnv('CLAVE_ELEVENLABS_BASE_URL', 'http://from-env.test/')
    vi.stubEnv('CLAVE_ELEVENLABS_ALLOW_BASE_URL', '1')
    try {
      expect(elevenLabsBaseUrl()).toBe('https://api.elevenlabs.io')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("ElevenLabs' own words (PRDCT-4831)", () => {
  it('reads the detail of an error body, an object or a sentence', () => {
    expect(serviceDetail(JSON.stringify(missing('voices_read').body))).toEqual({
      status: 'missing_permissions',
      type: 'authentication_error',
      message:
        'The API key you used is missing the permission voices_read to execute this operation.'
    })
    expect(serviceDetail('{"detail":"Not allowed"}')).toEqual({
      status: null,
      type: null,
      message: 'Not allowed'
    })
    for (const body of ['', 'not json', '{"detail":[1]}', 'null', '{"detail":{"status":3}}'])
      expect(serviceDetail(body)).toEqual({ status: null, type: null, message: null })
  })

  it('a refusal of the key is a 401, a 403 or an authentication error; spent credits are not', () => {
    const none = { status: null, type: null, message: null }
    expect(keyRefused(401, none)).toBe(true)
    expect(keyRefused(403, none)).toBe(true)
    expect(keyRefused(400, { ...none, type: 'authentication_error' })).toBe(true)
    expect(keyRefused(400, none)).toBe(false)
    expect(keyRefused(404, none)).toBe(false)
    expect(keyRefused(401, { ...none, status: 'quota_exceeded' })).toBe(false)
  })

  it('the sentence says the reason, the fix of a missing permission, and the plain refusal without one', () => {
    const detail = serviceDetail(JSON.stringify(missing('user_read').body))
    expect(refusedSentence(detail, KEY)).toBe(
      `ElevenLabs refused the key: ${detail.message} ${ELEVENLABS_PERMISSION_HINT}`
    )
    expect(refusedSentence({ status: 'x', type: null, message: 'No good' }, KEY)).toBe(
      'ElevenLabs refused the key: No good.'
    )
    expect(refusedSentence({ status: null, type: null, message: null }, KEY)).toBe(
      'The key was refused by ElevenLabs.'
    )
    // Nothing readable once the key is cut out: the plain refusal.
    expect(refusedSentence({ status: null, type: null, message: ` ${KEY} ` }, KEY)).toBe(
      'The key was refused by ElevenLabs.'
    )
  })

  it('cleans a reason: the key and key-shaped words cut out, one line, capped', () => {
    expect(cleanReason(`a ${KEY} b`, KEY)).toBe('a … b')
    expect(cleanReason(`a sk_${'f'.repeat(48)} b`, null)).toBe('a … b')
    expect(cleanReason(`a ${'Z9'.repeat(25)} b`, null)).toBe('a … b')
    expect(cleanReason('one\ntwo\u0007three', null)).toBe('one two three')
    const long = cleanReason('word '.repeat(200), null)
    expect(long.length).toBeLessThanOrEqual(300)
    expect(long.endsWith('…')).toBe(true)
    // The permission names stay readable.
    expect(cleanReason('missing the permission text_to_speech', null)).toBe(
      'missing the permission text_to_speech'
    )
  })
})
