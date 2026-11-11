import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  throw new Error('the integrations store imported electron')
})

import { electronTestPorts, standaloneTestPorts } from '../ports/testing'
import type { SettingsPorts } from '../ports/registry'
import { ElevenLabsIntegration, INTEGRATIONS_FILE } from './elevenlabs'

// The ElevenLabs integration on the host (PRDCT-4410): the key is sealed by
// the machine's secret port and appears in no document and no status; the
// account check and the voices are read from a stubbed `fetch`, never the
// service. Every key here is invented.

const KEY = 'xi-unit-test-key-0001'
const BASE = 'http://elevenlabs.test'

type Answer = { status: number; body?: unknown } | 'throw'
let answers: Map<string, Answer[]>
let requests: { url: string; key: string | null }[]

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      requests.push({ url: input, key: headers.get('xi-api-key') })
      const pathname = new URL(input).pathname
      const queue = answers.get(pathname) ?? []
      const answer = queue.length > 1 ? queue.shift()! : queue[0]
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

const fileText = (ports: { dir: string }): string =>
  fs.readFileSync(path.join(ports.dir, INTEGRATIONS_FILE), 'utf-8')

beforeEach(() => {
  answers = new Map([['/v1/user/subscription', [subscription]]])
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
    expect(requests[0]).toEqual({ url: `${BASE}/v1/user/subscription`, key: KEY })
  })

  it('a refused key is kept, and says so', async () => {
    answers.set('/v1/user/subscription', [{ status: 401 }])
    const status = await integration.setKey(KEY)
    expect(status.configured).toBe(true)
    expect(status.lastError).toBe('The key was refused by ElevenLabs.')
    expect(await integration.openKey()).toBe(KEY)
    answers.set('/v1/user/subscription', [{ status: 403 }])
    expect((await integration.check()).lastError).toBe('The key was refused by ElevenLabs.')
  })

  it('another status is named, and a network failure keeps the paste', async () => {
    answers.set('/v1/user/subscription', [{ status: 500 }])
    expect((await integration.setKey(KEY)).lastError).toBe('ElevenLabs answered 500.')
    answers.set('/v1/user/subscription', ['throw'])
    const status = await integration.check()
    expect(status.lastError).toBe('The server could not reach ElevenLabs.')
    expect(status.configured).toBe(true)
    expect(JSON.stringify(status)).not.toContain(KEY)
    answers.set('/v1/user/subscription', [subscription])
    expect((await integration.check()).lastError).toBeNull()
  })

  it('reads the voices page by page', async () => {
    await integration.setKey(KEY)
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
    const voiceCalls = requests.filter((r) => r.url.includes('/v2/voices'))
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

  it('the base URL comes from the environment by default', async () => {
    vi.stubEnv('CLAVE_ELEVENLABS_BASE_URL', 'http://from-env.test/')
    try {
      const integration = new ElevenLabsIntegration(electronTestPorts())
      await integration.setKey(KEY)
      expect(requests[0].url).toBe('http://from-env.test/v1/user/subscription')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
