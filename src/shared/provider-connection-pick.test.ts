import { describe, expect, it } from 'vitest'
import type { ProviderConnectionView } from '@clave/contract/settings/connections'
import { HARNESS_BY_ID } from './harness'
import {
  harnessProviderConnections,
  listedProviderConnection,
  pickProviderConnection,
  providerConnectionRefusal,
  resolveProviderConnection
} from './provider-connection-pick'

const c = (
  id: string,
  label: string,
  usable = true
): { id: string; label: string; usable: boolean } => ({
  id,
  label,
  usable
})
const work = c('c-work', 'Kimi work')
const home = c('c-home', 'Kimi home')
const unkeyed = c('c-ds', 'No key yet', false)

const view = (
  id: string,
  company: ProviderConnectionView['company'],
  label: string,
  opts: {
    needsKey?: boolean
    hasKey?: boolean
    endpoints?: ProviderConnectionView['endpoints']
  } = {}
): ProviderConnectionView => ({
  id,
  label,
  company,
  pool: company,
  kind: 'key',
  endpoints: opts.endpoints ?? [
    { wireFormat: 'openai-chat', baseUrl: 'https://e2e-made-up.example/v1' }
  ],
  needsKey: opts.needsKey ?? true,
  hasKey: opts.hasKey ?? true,
  keySetAt: null,
  createdAt: 0
})

describe('pickProviderConnection (PRDCT-4496)', () => {
  it('picks the first usable connection in the list order for no ref and for "any"', () => {
    for (const ref of [undefined, 'any']) {
      const pick = pickProviderConnection([unkeyed, work, home], ref)
      expect(pick).toEqual({ ok: true, connection: work })
    }
  })
  it('answers none, with every label, when no connection is usable or none is stored', () => {
    expect(pickProviderConnection([unkeyed], 'any')).toEqual({
      ok: false,
      reason: 'none',
      labels: ['No key yet']
    })
    expect(pickProviderConnection([], undefined)).toEqual({ ok: false, reason: 'none', labels: [] })
  })
  it('matches an exact id first, then an exact label, then a label in any case', () => {
    // A label equal to another's id: the id wins.
    const clash = c('Kimi home', 'Clash')
    expect(pickProviderConnection([home, clash], 'Kimi home')).toEqual({
      ok: true,
      connection: clash
    })
    expect(pickProviderConnection([work, home], 'Kimi home')).toEqual({
      ok: true,
      connection: home
    })
    const upper = c('c-up', 'KIMI WORK')
    // An exact label before a case-insensitive one, whatever the order.
    expect(pickProviderConnection([upper, work], 'Kimi work')).toEqual({
      ok: true,
      connection: work
    })
    expect(pickProviderConnection([work, home], 'kimi HOME')).toEqual({
      ok: true,
      connection: home
    })
  })
  it('answers a named connection with no key, the spawn saying why it cannot start', () => {
    expect(pickProviderConnection([work, unkeyed], 'No key yet')).toEqual({
      ok: true,
      connection: unkeyed
    })
  })
  it('answers unknown with the label of every connection', () => {
    expect(pickProviderConnection([work, unkeyed], 'Nobody')).toEqual({
      ok: false,
      reason: 'unknown',
      labels: ['Kimi work', 'No key yet']
    })
  })
})

describe('the refusal sentences', () => {
  it('names the list the way an unknown Claude account does, and says what to do when none serves', () => {
    expect(providerConnectionRefusal('Pi', 'Nobody', { reason: 'unknown' }, [work, unkeyed])).toBe(
      'Unknown Pi connection "Nobody". Available: "Kimi work" (c-work), "No key yet" (c-ds)'
    )
    expect(providerConnectionRefusal('Pi', 'any', { reason: 'none' }, [])).toBe(
      'No stored connection serves Pi yet: add one in Settings → Connections.'
    )
    expect(providerConnectionRefusal('OpenCode', 'Nobody', { reason: 'unknown' }, [])).toBe(
      'No stored connection serves OpenCode yet: add one in Settings → Connections.'
    )
    expect(providerConnectionRefusal('Pi', 'any', { reason: 'none' }, [unkeyed])).toBe(
      'No stored connection of Pi has its key yet: set one in Settings → Connections.'
    )
  })
})

describe("a harness's stored connections, in the listing's order", () => {
  it('orders them pool by pool in the harness order, keeps those serving its wire formats, usable by key', () => {
    const views = [
      view('c-ollama', 'ollama', 'Local', { needsKey: false, hasKey: false }),
      view('c-kimi', 'moonshot', 'Kimi work'),
      view('c-ds', 'deepseek', 'No key yet', { hasKey: false }),
      view('c-none', 'moonshot', 'Serves nothing', { endpoints: [] })
    ]
    expect(harnessProviderConnections(HARNESS_BY_ID.pi, views)).toEqual([
      { id: 'c-kimi', label: 'Kimi work', company: 'moonshot', usable: true },
      { id: 'c-ds', label: 'No key yet', company: 'deepseek', usable: false },
      { id: 'c-ollama', label: 'Local', company: 'ollama', usable: true }
    ])
    // Claude's pool is its accounts: no stored connection serves it.
    expect(harnessProviderConnections(HARNESS_BY_ID.claude, views)).toEqual([])
  })
  it('resolves an account to the connection or to the sentence', () => {
    const views = [view('c-kimi', 'moonshot', 'Kimi work')]
    expect(resolveProviderConnection(HARNESS_BY_ID.opencode, views, 'kimi work')).toMatchObject({
      ok: true,
      connection: { id: 'c-kimi', label: 'Kimi work' }
    })
    expect(resolveProviderConnection(HARNESS_BY_ID.opencode, views, 'Nobody')).toEqual({
      ok: false,
      reason: 'Unknown OpenCode connection "Nobody". Available: "Kimi work" (c-kimi)'
    })
  })
})

describe("clave_list's connection of a Pi or OpenCode tab", () => {
  it("reports the store's label, else the record's, never exhausted; none off a stored connection", () => {
    const record = { piMode: true, connectionId: 'c-kimi', connectionLabel: 'Kimi (old name)' }
    expect(listedProviderConnection(record, () => 'Kimi work')).toEqual({
      id: 'c-kimi',
      label: 'Kimi work',
      exhausted: false
    })
    expect(listedProviderConnection(record, () => undefined)?.label).toBe('Kimi (old name)')
    expect(listedProviderConnection({ piMode: true }, () => 'x')).toBeNull()
    expect(
      listedProviderConnection({ piMode: false, connectionId: 'c-kimi' }, () => 'x')
    ).toBeNull()
  })
})
