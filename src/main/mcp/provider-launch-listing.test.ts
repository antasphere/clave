import { describe, expect, it } from 'vitest'
import type { ProviderConnectionView } from '@clave/contract/settings/connections'
import type { SessionRecord } from '@clave/contract/sessions'
import { HARNESS_BY_ID } from '../../shared/harness'
import {
  providerPoolConnections,
  servedAccountOf,
  type ServedAccountReads
} from './provider-launch-listing'

const view = (
  id: string,
  wireFormat: 'openai-chat' | 'anthropic-messages'
): ProviderConnectionView =>
  ({
    id,
    label: `${id} label`,
    company: 'moonshot',
    kind: 'key',
    pool: 'moonshot',
    endpoints: [{ wireFormat, baseUrl: 'https://made-up.invalid/v1' }],
    needsKey: true,
    hasKey: true,
    keySetAt: 1,
    createdAt: 1
  }) as ProviderConnectionView

describe('providerPoolConnections (PRDCT-4496)', () => {
  it('keeps only the connections serving a wire format the harness speaks, as the open does', () => {
    const views = [view('chat-only', 'openai-chat'), view('messages', 'anthropic-messages')]
    // A Pi row speaking Anthropic's messages only.
    const narrow = { ...HARNESS_BY_ID.pi, wireFormats: ['anthropic-messages'] as const }
    expect(providerPoolConnections('moonshot', views, narrow).map((c) => c.id)).toEqual([
      'messages'
    ])
    expect(providerPoolConnections('moonshot', views, HARNESS_BY_ID.pi).map((c) => c.id)).toEqual([
      'chat-only',
      'messages'
    ])
    expect(providerPoolConnections('claude', views, HARNESS_BY_ID.pi)).toEqual([])
  })
})

describe('servedAccountOf: the account the Mac’s served clave_list reports', () => {
  const reads: ServedAccountReads = {
    accountLabel: (pool, id) => (pool === 'claude' && id === 'work' ? 'Work (now)' : undefined),
    exhausted: (pool, id, model) => pool === 'claude' && id === 'work' && model === 'opus',
    providerConnectionLabel: (id) => (id === 'kimi-1' ? 'Kimi work (renamed)' : undefined)
  }
  const record = (over: Partial<SessionRecord>): SessionRecord => ({ ...over }) as SessionRecord

  it("reports a Pi tab's stored connection with the store's current label, never exhausted", () => {
    expect(
      servedAccountOf(
        record({ piMode: true, connectionId: 'kimi-1', connectionLabel: 'Kimi work' }),
        reads
      )
    ).toEqual({ id: 'kimi-1', label: 'Kimi work (renamed)', exhausted: false })
    expect(
      servedAccountOf(
        record({ opencodeMode: true, connectionId: 'gone', connectionLabel: 'Kept label' }),
        reads
      )
    ).toEqual({ id: 'gone', label: 'Kept label', exhausted: false })
  })

  it('keeps a Claude tab on its account: the store label, judged for its model', () => {
    expect(
      servedAccountOf(
        record({
          claudeMode: true,
          claudeProfileId: 'work',
          claudeProfileLabel: 'Old',
          model: 'opus'
        }),
        reads
      )
    ).toEqual({ id: 'work', label: 'Work (now)', exhausted: true })
    expect(servedAccountOf(record({ claudeMode: true }), reads)).toEqual({
      id: 'default',
      label: 'Removed account',
      exhausted: false
    })
    expect(
      servedAccountOf(record({ codexMode: true, codexAccountLabel: 'Kept codex' }), reads)
    ).toEqual({ id: 'default', label: 'Kept codex', exhausted: false })
  })

  it('answers null for a terminal and for a Pi tab on no stored connection', () => {
    expect(servedAccountOf(record({}), reads)).toBeNull()
    expect(servedAccountOf(record({ piMode: true }), reads)).toBeNull()
  })
})
