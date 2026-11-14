/**
 * Whether a History row can be reopened from here (PRDCT-4321): a live tab
 * always; a server's conversation only while its server is connected, a tab
 * of the server that still holds it whatever its transcript, one the server
 * does not list by its folder alone; a closed one, and this Mac's own, need
 * their transcript and their folder. And how a server's row is reopened
 * (`resumeHistoryEntry`): a stopped holder restarted in place, a running one
 * shown, a closed or unlisted one started on its server, nothing while the
 * server is offline. The stores and the window's API are stubbed out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  session: {
    sessions: [] as Array<Record<string, unknown>>,
    groups: [] as Array<{ id: string }>,
    selectSession: (() => {}) as (id: string, multi: boolean) => void,
    setFocusedSession: (() => {}) as (id: string) => void,
    moveItems: (() => {}) as (ids: string[], group: string, where: string) => void,
    addSessionInGroup: (() => {}) as (...args: unknown[]) => void
  },
  statuses: {} as Record<string, { state: string }>
}))

vi.mock('../store/session-store', () => ({
  useSessionStore: { getState: () => h.session, subscribe: () => () => {} },
  inActiveWorkspace: () => true
}))
vi.mock('../store/workspace-store', () => ({ getActiveWorkspaceId: () => null }))
vi.mock('../store/claude-profile-store', () => ({
  useClaudeProfileStore: { getState: () => ({ profiles: [] }) }
}))
vi.mock('../store/codex-account-store', () => ({
  useCodexAccountStore: { getState: () => ({ accounts: [] }) }
}))
vi.mock('../store/fleet-store', () => ({
  useFleetStore: { getState: () => ({ statuses: h.statuses }) }
}))

import { resourceKey, sessionKey } from '@clave/contract/fleet'
import { canResumeHistoryEntry, resumeHistoryEntry } from './session-history'
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

  it('reopens a conversation its connected server does not list by its folder alone', () => {
    // Its transcript is on the server's disk, unknown here.
    expect(canResumeHistoryEntry(withoutTranscript(onServer(null)), false, connected)).toBe(true)
    expect(canResumeHistoryEntry(onServer(null, { cwd: '' }), false, connected)).toBe(false)
    expect(canResumeHistoryEntry(onServer(null), false, disconnected)).toBe(false)
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

describe('resumeHistoryEntry: a server’s row reopened on its server (PRDCT-4321)', () => {
  const TAB = sessionKey({ serverId: 'srv', sessionId: 'tab-1' })
  const SERVER_WS = resourceKey('workspace', 'srv', 'ws-1')
  const NEW_TAB = sessionKey({ serverId: 'srv', sessionId: 'tab-new' })
  let api: Record<
    'restartSession' | 'fleetSnapshot' | 'fleetStart' | 'spawnSession',
    ReturnType<typeof vi.fn>
  >
  let selected: string[]

  beforeEach(() => {
    selected = []
    h.session.sessions = []
    h.session.groups = []
    h.session.selectSession = (id) => {
      selected.push(id)
    }
    h.session.setFocusedSession = () => {}
    h.session.moveItems = vi.fn()
    h.statuses = { srv: { state: 'connected' } }
    api = {
      restartSession: vi.fn().mockResolvedValue({ ok: true }),
      fleetSnapshot: vi.fn().mockResolvedValue(undefined),
      fleetStart: vi.fn().mockResolvedValue({ id: NEW_TAB }),
      spawnSession: vi.fn().mockResolvedValue({ id: 'mac-tab' })
    }
    vi.stubGlobal('window', { electronAPI: api })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const ran = (
    held: HistoryServerRef['held'],
    over: Partial<HistoryListEntry> = {}
  ): HistoryListEntry =>
    onServer(held, {
      sessionId: TAB,
      cwd: '/srv/odoo',
      workspaceId: SERVER_WS,
      launchProfileId: 'chat:claude:mine',
      ...over
    })
  const resume = (e: HistoryListEntry): Promise<string | null> =>
    resumeHistoryEntry(e, { groupId: null, dangerousMode: false })

  it('restarts a stopped holder in place, never a second tab on its conversation', async () => {
    expect(await resume(ran('stopped'))).toBe(TAB)
    expect(api.restartSession).toHaveBeenCalledWith(TAB, { onlyIfStopped: true })
    expect(api.fleetStart).not.toHaveBeenCalled()
    expect(api.spawnSession).not.toHaveBeenCalled()
    expect(selected).toEqual([TAB])
  })

  it('shows a running holder this window does not show yet, starting nothing', async () => {
    expect(await resume(ran('running'))).toBe(TAB)
    expect(api.restartSession).not.toHaveBeenCalled()
    expect(api.fleetStart).not.toHaveBeenCalled()
    expect(api.spawnSession).not.toHaveBeenCalled()
    expect(api.fleetSnapshot).toHaveBeenCalledWith('srv')
    expect(selected).toEqual([TAB])
  })

  it('starts a closed conversation on its server, on the profile and in the server workspace it ran in', async () => {
    expect(await resume(ran('closed'))).toBe(NEW_TAB)
    expect(api.fleetStart).toHaveBeenCalledTimes(1)
    const [serverId, cwd, options] = api.fleetStart.mock.calls[0]
    expect(serverId).toBe('srv')
    expect(cwd).toBe('/srv/odoo')
    expect(options).toMatchObject({
      claudeMode: true,
      resumeSessionId: 'c1',
      launchProfileId: 'chat:claude:mine',
      workspaceId: SERVER_WS
    })
    expect(api.spawnSession).not.toHaveBeenCalled()
    expect(api.restartSession).not.toHaveBeenCalled()
    expect(selected).toEqual([NEW_TAB])
  })

  it('never passes one of this Mac’s workspaces to the server', async () => {
    await resume(ran('closed', { workspaceId: 'ws-mac' }))
    expect(api.fleetStart).toHaveBeenCalledTimes(1)
    expect(api.fleetStart.mock.calls[0][2]).not.toHaveProperty('workspaceId')
    await resume(ran('closed', { workspaceId: resourceKey('workspace', 'other', 'ws-1') }))
    expect(api.fleetStart.mock.calls[1][2]).not.toHaveProperty('workspaceId')
  })

  it('does nothing while the server is offline', async () => {
    h.statuses = { srv: { state: 'offline' } }
    for (const held of ['running', 'stopped', 'closed', null] as const)
      expect(await resume(ran(held))).toBeNull()
    expect(api.restartSession).not.toHaveBeenCalled()
    expect(api.fleetStart).not.toHaveBeenCalled()
    expect(api.spawnSession).not.toHaveBeenCalled()
    expect(selected).toEqual([])
  })

  it('starts a conversation its server does not list there, its transcript unchecked', async () => {
    expect(await resume(withoutTranscript(ran(null)))).toBe(NEW_TAB)
    expect(api.fleetStart).toHaveBeenCalledWith(
      'srv',
      '/srv/odoo',
      expect.objectContaining({ claudeMode: true, resumeSessionId: 'c1' })
    )
    expect(api.spawnSession).not.toHaveBeenCalled()
  })

  it('restarts a stopped tab of that server holding an unlisted conversation, starting nothing', async () => {
    // An older server lists nothing, so the row says held null; the stopped
    // tab is in this window's store all the same.
    const HOLDER = sessionKey({ serverId: 'srv', sessionId: 'tab-stopped' })
    h.session.sessions = [{ id: HOLDER, alive: false, claudeSessionId: 'c1' }]
    expect(await resume(ran(null))).toBe(HOLDER)
    expect(api.restartSession).toHaveBeenCalledTimes(1)
    expect(api.restartSession).toHaveBeenCalledWith(HOLDER, { onlyIfStopped: true })
    expect(api.fleetStart).not.toHaveBeenCalled()
    expect(api.spawnSession).not.toHaveBeenCalled()
    expect(api.fleetSnapshot).toHaveBeenCalledWith('srv')
    expect(selected).toEqual([HOLDER])
  })

  it('takes no stopped tab of another server for the holder, and starts on this one', async () => {
    h.session.sessions = [
      {
        id: sessionKey({ serverId: 'other', sessionId: 'tab-1' }),
        alive: false,
        claudeSessionId: 'c1'
      }
    ]
    expect(await resume(ran(null))).toBe(NEW_TAB)
    expect(api.restartSession).not.toHaveBeenCalled()
    expect(api.fleetStart).toHaveBeenCalledTimes(1)
    expect(api.fleetStart.mock.calls[0][0]).toBe('srv')
  })

  it('starts nothing for a closed conversation whose transcript left the server', async () => {
    expect(await resume(withoutTranscript(ran('closed')))).toBeNull()
    expect(api.fleetStart).not.toHaveBeenCalled()
  })

  it('reopens a Pi conversation on a clave-* provider on Pi’s own default, a harness provider kept (PRDCT-4534)', async () => {
    const pi = (agentProvider: string): HistoryListEntry =>
      entry({ provider: 'pi', mode: 'pi', model: 'qwen-max', agentProvider })
    expect(await resume(pi('clave-alibaba'))).toBe('mac-tab')
    const [, dropped] = api.spawnSession.mock.calls[0]
    expect(dropped).toMatchObject({ piMode: true, resumeSessionId: 'c1' })
    expect(dropped.piProvider).toBeUndefined()
    expect(dropped.model).toBeUndefined()
    await resume(pi('kimi-coding'))
    expect(api.spawnSession.mock.calls[1][1]).toMatchObject({
      piProvider: 'kimi-coding',
      model: 'qwen-max'
    })
  })
})
