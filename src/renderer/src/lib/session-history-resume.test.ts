/**
 * Whether a History row can be reopened from here (PRDCT-4321): a live tab
 * always; a server's conversation only while its server is connected and
 * knows it, a tab of the server that still holds it whatever its transcript;
 * a closed one, and this Mac's own, need their transcript and their folder.
 * The stores are not this rule's: they are stubbed out of the import.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../store/session-store', () => ({
  useSessionStore: { getState: () => ({}), subscribe: () => () => {} },
  inActiveWorkspace: () => true
}))
vi.mock('../store/workspace-store', () => ({ getActiveWorkspaceId: () => null }))
vi.mock('../store/claude-profile-store', () => ({
  useClaudeProfileStore: { getState: () => ({ profiles: [] }) }
}))
vi.mock('../store/codex-account-store', () => ({
  useCodexAccountStore: { getState: () => ({ accounts: [] }) }
}))
vi.mock('../store/fleet-store', () => ({ useFleetStore: { getState: () => ({ statuses: {} }) } }))

import { sessionKey } from '@clave/contract/fleet'
import { canResumeHistoryEntry } from './session-history'
import type { HistoryListEntry, HistoryServerRef } from '../../../preload/index.d'

const entry = (over: Partial<HistoryListEntry> = {}): HistoryListEntry => ({
  source: 'ledger',
  provider: 'claude',
  claudeSessionId: 'c1',
  sessionId: 'tab-1',
  name: 'Odoo',
  cwd: '/work/odoo',
  mode: 'claude',
  model: null,
  workspaceId: null,
  groups: [],
  firstSeenAt: '2026-11-01T10:00:00.000Z',
  lastSeenAt: '2026-11-09T10:00:00.000Z',
  closedAt: null,
  transcript: {
    exists: true,
    path: '/t/c1.jsonl',
    cwd: '/work/odoo',
    firstAt: null,
    title: null,
    lastPrompt: null,
    lastHumanAt: null,
    modifiedAt: null,
    sizeBytes: 10
  },
  title: 'Odoo research',
  lastHumanAt: '2026-11-09T10:00:00.000Z',
  ...over
})

const withoutTranscript = (e: HistoryListEntry): HistoryListEntry => ({
  ...e,
  transcript: { ...e.transcript, exists: false }
})

const onServer = (
  held: HistoryServerRef['held'],
  over: Partial<HistoryListEntry> = {}
): HistoryListEntry =>
  entry({
    source: 'server',
    sessionId: sessionKey({ serverId: 'srv', sessionId: 'tab-1' }),
    server: { id: 'srv', name: 'Studio', online: true, held },
    ...over
  })

const connected = (): boolean => true
const disconnected = (): boolean => false

describe('canResumeHistoryEntry (PRDCT-4321)', () => {
  it('always reopens a live tab, whatever else the row says', () => {
    expect(canResumeHistoryEntry(withoutTranscript(entry({ cwd: '' })), true, connected)).toBe(true)
    expect(canResumeHistoryEntry(entry({ provider: 'codex' }), true, connected)).toBe(true)
    expect(canResumeHistoryEntry(onServer(null), true, disconnected)).toBe(true)
  })

  it('never reopens a provider the History does not resume', () => {
    expect(canResumeHistoryEntry(entry({ provider: 'codex' }), false, connected)).toBe(false)
    expect(canResumeHistoryEntry(entry({ provider: 'antigravity' }), false, connected)).toBe(false)
    expect(canResumeHistoryEntry(entry({ provider: 'pi' }), false, connected)).toBe(true)
  })

  it('never reopens a server’s conversation while its server is disconnected', () => {
    const asked: string[] = []
    const ask = (id: string): boolean => {
      asked.push(id)
      return false
    }
    expect(canResumeHistoryEntry(onServer('closed'), false, ask)).toBe(false)
    expect(canResumeHistoryEntry(onServer('running'), false, ask)).toBe(false)
    expect(asked).toEqual(['srv', 'srv'])
  })

  it('never reopens a server’s conversation the server does not know', () => {
    expect(canResumeHistoryEntry(onServer(null), false, connected)).toBe(false)
  })

  it('reopens the tab of the server that still holds it, even with its transcript gone', () => {
    expect(canResumeHistoryEntry(withoutTranscript(onServer('stopped')), false, connected)).toBe(
      true
    )
    expect(canResumeHistoryEntry(withoutTranscript(onServer('running')), false, connected)).toBe(
      true
    )
  })

  it('reopens a closed server conversation only with its transcript and its folder', () => {
    expect(canResumeHistoryEntry(onServer('closed'), false, connected)).toBe(true)
    expect(canResumeHistoryEntry(withoutTranscript(onServer('closed')), false, connected)).toBe(
      false
    )
    expect(canResumeHistoryEntry(onServer('closed', { cwd: '' }), false, connected)).toBe(false)
  })

  it('reopens this Mac’s own conversation only with its transcript and its folder', () => {
    expect(canResumeHistoryEntry(entry(), false, disconnected)).toBe(true)
    expect(canResumeHistoryEntry(withoutTranscript(entry()), false, connected)).toBe(false)
    expect(canResumeHistoryEntry(entry({ cwd: '' }), false, connected)).toBe(false)
  })
})
