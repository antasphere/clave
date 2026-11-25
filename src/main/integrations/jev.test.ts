import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  throw new Error('the Jev key store imported electron')
})

import { electronTestPorts, standaloneTestPorts } from '../ports/testing'
import type { SettingsPorts } from '../ports/registry'
import { JEV_REFUSED_PREFIX } from '../../shared/jev'
import { INTEGRATIONS_FILE } from './document'
import {
  JevIntegration,
  JEV_API,
  JEV_REFUSED,
  JEV_UNREACHABLE,
  jevBaseUrl,
  jevBaseUrlOverride,
  jevDetailText
} from './jev'

// The Jev key on the host (PRDCT-5179): sealed by the machine's secret port,
// in no document and no status, checked against the list of models of a
// stubbed `fetch`, never TypeSafe itself. Every key here is invented.

const KEY = 'ts-unit-test-key-0001'
const BASE = 'http://typesafe.test'

type Answer = { status: number; body?: unknown } | 'throw'
let answers: Array<Answer | Promise<Answer>>
let requests: { url: string; authorization: string | null; method: string }[]

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      requests.push({
        url: input,
        authorization: headers.get('authorization'),
        method: init?.method ?? 'GET'
      })
      const queued = answers.length > 1 ? answers.shift()! : answers[0]
      const answer = await queued
      if (!answer || answer === 'throw') throw new TypeError('fetch failed')
      return new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status,
        headers: { 'content-type': 'application/json' }
      })
    })
  )
}

const models = {
  status: 200,
  body: { models: [{ name: 'jev-latest', description: 'A model.', release_date: '2026-09-15' }] }
}

const fileText = (ports: { dir: string }): string =>
  fs.readFileSync(path.join(ports.dir, INTEGRATIONS_FILE), 'utf-8')

beforeEach(() => {
  answers = [models]
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
  let integration: JevIntegration
  beforeEach(() => {
    ports = make()
    integration = new JevIntegration(ports, { baseUrl: () => BASE, now: () => 1000 })
  })

  it('says not configured before a key', () => {
    expect(integration.status()).toEqual({
      configured: false,
      setAt: null,
      checkedAt: null,
      lastError: null
    })
  })

  it('stores the key sealed and checks it against the models: never in the document, never in the status', async () => {
    const status = await integration.setKey(`  ${KEY}  `)
    expect(status).toEqual({ configured: true, setAt: 1000, checkedAt: 1000, lastError: null })
    expect(fileText(ports)).not.toContain(KEY)
    expect(JSON.stringify(status)).not.toContain(KEY)
    expect(requests).toEqual([
      { url: `${BASE}/v1/models`, authorization: `Bearer ${KEY}`, method: 'GET' }
    ])
    expect(await integration.openKey()).toBe(KEY)
    expect(JSON.parse(fileText(ports))).toMatchObject({ version: 1, jev: { setAt: 1000 } })
  })

  it("a refused key says TypeSafe's own reason, the key cut out", async () => {
    answers = [{ status: 401, body: { detail: `Invalid API key ${KEY} for this account` } }]
    const status = await integration.setKey(KEY)
    expect(status.configured).toBe(true)
    expect(status.lastError).toBe(`${JEV_REFUSED_PREFIX}Invalid API key … for this account.`)
    expect(fileText(ports)).not.toContain(KEY)
  })

  it('a refused key with no reason says the plain refusal, a 403 too', async () => {
    answers = [{ status: 403, body: {} }]
    expect((await integration.setKey(KEY)).lastError).toBe(JEV_REFUSED)
    answers = [{ status: 401, body: { detail: KEY } }]
    expect((await integration.check()).lastError).toBe(JEV_REFUSED)
  })

  it('an unreachable TypeSafe keeps the paste and says so', async () => {
    answers = ['throw']
    const status = await integration.setKey(KEY)
    expect(status).toMatchObject({ configured: true, lastError: JEV_UNREACHABLE })
    expect(await integration.openKey()).toBe(KEY)
    // The next check that passes clears it.
    answers = [models]
    expect((await integration.check()).lastError).toBeNull()
  })

  it('another status is named', async () => {
    answers = [{ status: 529, body: { detail: 'Overloaded' } }]
    expect((await integration.setKey(KEY)).lastError).toBe('TypeSafe answered 529.')
  })

  it('remove discards the sealed handle and deletes the entry', async () => {
    await integration.setKey(KEY)
    const discard = vi.spyOn(ports.secrets, 'discard')
    const status = await integration.removeKey()
    expect(status.configured).toBe(false)
    expect(discard).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fileText(ports))).toEqual({ version: 1 })
    expect(await integration.openKey()).toBeNull()
  })

  it('a replaced key discards the old handle', async () => {
    await integration.setKey(KEY)
    const discard = vi.spyOn(ports.secrets, 'discard')
    await integration.setKey('ts-unit-test-key-0002')
    expect(discard).toHaveBeenCalledTimes(1)
    expect(await integration.openKey()).toBe('ts-unit-test-key-0002')
  })

  it('a Replace during a check wins: the check writes nothing onto the new key', async () => {
    await integration.setKey(KEY)
    let release!: (answer: Answer) => void
    answers = [new Promise<Answer>((resolve) => (release = resolve)), models]
    const checking = integration.check()
    await vi.waitFor(() => expect(requests.length).toBe(2))
    // The new key is checked (and passes) while the first check still waits.
    const replaced = await integration.setKey('ts-unit-test-key-0002')
    expect(replaced.lastError).toBeNull()
    release({ status: 401, body: { detail: 'Invalid API key' } })
    await checking
    expect(integration.status().lastError).toBeNull()
    expect(await integration.openKey()).toBe('ts-unit-test-key-0002')
  })

  it('a Remove during a check leaves no entry', async () => {
    await integration.setKey(KEY)
    let release!: (answer: Answer) => void
    answers = [new Promise<Answer>((resolve) => (release = resolve))]
    const checking = integration.check()
    await vi.waitFor(() => expect(requests.length).toBe(2))
    await integration.removeKey()
    release({ status: 401, body: {} })
    expect((await checking).configured).toBe(false)
    expect(integration.status().configured).toBe(false)
  })

  it('emits the status after each write, never the key', async () => {
    const seen: string[] = []
    integration.onChange((status) => seen.push(JSON.stringify(status)))
    await integration.setKey(KEY)
    await integration.removeKey()
    expect(seen.length).toBeGreaterThanOrEqual(3)
    for (const status of seen) expect(status).not.toContain(KEY)
  })
})

describe('refusals', () => {
  it('an empty paste is refused', async () => {
    const integration = new JevIntegration(electronTestPorts(), { baseUrl: () => BASE })
    await expect(integration.setKey('   ')).rejects.toThrow('Paste the API key first.')
  })

  it('an unavailable secret port refuses, and nothing is stored', async () => {
    const ports = electronTestPorts(undefined, { available: false })
    const integration = new JevIntegration(ports, { baseUrl: () => BASE })
    await expect(integration.setKey(KEY)).rejects.toThrow('This machine cannot store a secret.')
    expect(fs.existsSync(path.join(ports.dir, INTEGRATIONS_FILE))).toBe(false)
    expect(requests).toEqual([])
  })

  it('the base URL variable is ignored outside the test harness', async () => {
    vi.stubEnv('CLAVE_JEV_BASE_URL', 'http://from-env.test/')
    try {
      expect(jevBaseUrl()).toBe(JEV_API)
      const integration = new JevIntegration(electronTestPorts())
      await integration.setKey(KEY)
      expect(requests.map((r) => r.url)).toEqual(['https://api.typesafe.ai/v1/models'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('the base URL variable is honoured under the harness only', () => {
    const named = { CLAVE_JEV_BASE_URL: ' http://from-env.test/ ' }
    expect(jevBaseUrlOverride(named, false)).toBeNull()
    expect(jevBaseUrlOverride(named, true)).toBe('http://from-env.test/')
    expect(jevBaseUrlOverride({}, true)).toBeNull()
  })
})

describe("TypeSafe's own words", () => {
  it('reads the detail of an error body: a sentence, an object, a validation list', () => {
    expect(jevDetailText('{"detail":"Invalid API key"}')).toBe('Invalid API key')
    expect(jevDetailText('{"detail":{"message":"Nope"}}')).toBe('Nope')
    expect(
      jevDetailText('{"detail":[{"loc":["body","state"],"msg":"Field required","type":"missing"}]}')
    ).toBe('Field required')
    expect(jevDetailText('not json')).toBeNull()
    expect(jevDetailText('{}')).toBeNull()
  })
})
