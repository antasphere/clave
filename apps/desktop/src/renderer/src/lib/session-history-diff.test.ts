/**
 * The ledger diff (PRDCT-1738): a tab is stamped once per placement identity,
 * a move into a group is a row AT THE MOVE (not at the next hook word), a
 * rename and a `/clear` rotation are rows, a closed tab is a `closed` row
 * carrying its last identity, and the hidden halves (in no group, not in the
 * display order) are never stamped.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  SessionHistoryDiff,
  dotStateOf,
  encodeProjectDir,
  resumeTargetGroup,
  tabSessions,
  visibleInWorkspace,
  type LayoutState
} from './session-history-diff'
import type { Session, SessionGroup } from '../store/session-types'
import type { HistoryLedgerRow } from '../../../preload/index.d'

function session(over: Partial<Session>): Session {
  return {
    id: 's1',
    cwd: '/tmp/proj',
    folderName: 'proj',
    name: 'proj',
    alive: true,
    activityStatus: 'idle',
    promptWaiting: null,
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    dangerousMode: false,
    claudeSessionId: 'cc-1',
    sessionType: 'local',
    detectedUrl: null,
    serverStatus: null,
    serverCommand: null,
    hasUnseenActivity: false,
    userRenamed: false,
    planFilePath: null,
    workspaceId: 'ws-1',
    ...over
  }
}

function group(over: Partial<SessionGroup>): SessionGroup {
  return {
    id: 'g1',
    name: 'Alpha',
    sessionIds: [],
    collapsed: false,
    cwd: null,
    terminals: [],
    ...over
  }
}

function harness(): { diff: SessionHistoryDiff; rows: HistoryLedgerRow[] } {
  const rows: HistoryLedgerRow[] = []
  let tick = 0
  const diff = new SessionHistoryDiff(
    (r) => rows.push(r),
    () => `2026-08-25T10:00:0${tick++}.000Z`
  )
  return { diff, rows }
}

describe('SessionHistoryDiff', () => {
  it('stamps a new tab once, then nothing while its identity holds', () => {
    const { diff, rows } = harness()
    const state: LayoutState = { sessions: [session({})], groups: [], displayOrder: ['s1'] }
    diff.apply(state)
    diff.apply({ ...state, sessions: [session({ activityStatus: 'active' })] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'placed',
      sessionId: 's1',
      claudeSessionId: 'cc-1',
      groupId: null,
      mode: 'claude',
      workspaceId: 'ws-1'
    })
  })

  it('a move into a group is a row at the move, carrying the group id and name', () => {
    const { diff, rows } = harness()
    diff.apply({ sessions: [session({})], groups: [], displayOrder: ['s1'] })
    diff.apply({
      sessions: [session({})],
      groups: [group({ sessionIds: ['s1'] })],
      displayOrder: ['g1']
    })
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ kind: 'placed', groupId: 'g1', groupName: 'Alpha' })
  })

  it('a group rename, a tab rename and a /clear rotation each make a row', () => {
    const { diff, rows } = harness()
    const g = group({ sessionIds: ['s1'] })
    diff.apply({ sessions: [session({})], groups: [g], displayOrder: ['g1'] })
    diff.apply({
      sessions: [session({})],
      groups: [{ ...g, name: 'Alpha 2' }],
      displayOrder: ['g1']
    })
    diff.apply({
      sessions: [session({ name: 'fix login' })],
      groups: [{ ...g, name: 'Alpha 2' }],
      displayOrder: ['g1']
    })
    diff.apply({
      sessions: [session({ name: 'fix login', claudeSessionId: 'cc-2' })],
      groups: [{ ...g, name: 'Alpha 2' }],
      displayOrder: ['g1']
    })
    expect(rows.map((r) => [r.groupName, r.name, r.claudeSessionId])).toEqual([
      ['Alpha', 'proj', 'cc-1'],
      ['Alpha 2', 'proj', 'cc-1'],
      ['Alpha 2', 'fix login', 'cc-1'],
      ['Alpha 2', 'fix login', 'cc-2']
    ])
  })

  it('a tab leaving the store is a closed row with its LAST identity', () => {
    const { diff, rows } = harness()
    diff.apply({
      sessions: [session({})],
      groups: [group({ sessionIds: ['s1'] })],
      displayOrder: ['g1']
    })
    diff.apply({ sessions: [], groups: [group({})], displayOrder: ['g1'] })
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      kind: 'closed',
      sessionId: 's1',
      groupId: 'g1',
      groupName: 'Alpha'
    })
    expect(rows[1].ts).not.toBe(rows[0].ts)
    // Gone means gone: no second closed row on the next pass.
    diff.apply({ sessions: [], groups: [group({})], displayOrder: ['g1'] })
    expect(rows).toHaveLength(2)
  })

  it('the hidden halves and remote sessions are not tabs', () => {
    const state: LayoutState = {
      sessions: [
        session({ id: 'tab', claudeSessionId: null, claudeMode: false }),
        session({ id: 'hidden-server' }),
        session({ id: 'remote', sessionType: 'remote-claude' })
      ],
      groups: [group({ sessionIds: ['tab'] })],
      displayOrder: ['g1', 'remote']
    }
    expect(tabSessions(state).map((s) => s.id)).toEqual(['tab'])
    const { diff, rows } = harness()
    diff.apply(state)
    expect(rows.map((r) => r.sessionId)).toEqual(['tab'])
    expect(rows[0].mode).toBe('terminal')
    expect(rows[0].claudeSessionId).toBeNull()
  })

  it('an empty display order is the legacy "every session is a tab"', () => {
    expect(tabSessions({ sessions: [session({})], groups: [], displayOrder: [] })).toHaveLength(1)
  })
})

describe('the diff key', () => {
  it('a move between workspaces is a row (the dialog filters on it)', () => {
    const { diff, rows } = harness()
    diff.apply({ sessions: [session({})], groups: [], displayOrder: ['s1'] })
    diff.apply({ sessions: [session({ workspaceId: 'ws-2' })], groups: [], displayOrder: ['s1'] })
    expect(rows.map((r) => r.workspaceId)).toEqual(['ws-1', 'ws-2'])
  })

  it('two identities that only differ across a field boundary do not collide', () => {
    const { diff, rows } = harness()
    diff.apply({
      sessions: [session({ name: 'c' })],
      groups: [group({ name: 'a b', sessionIds: ['s1'] })],
      displayOrder: ['g1']
    })
    diff.apply({
      sessions: [session({ name: 'b c' })],
      groups: [group({ name: 'a', sessionIds: ['s1'] })],
      displayOrder: ['g1']
    })
    expect(rows).toHaveLength(2)
  })

  it('the source file is text — no raw control byte, so git can diff it', () => {
    const src = readFileSync(join(__dirname, 'session-history-diff.ts'), 'utf-8')
    const control = [...src].some((ch) => {
      const c = ch.charCodeAt(0)
      return c < 9 || c === 11 || c === 12 || (c >= 14 && c < 32)
    })
    expect(control).toBe(false)
  })
})

describe('resumeTargetGroup', () => {
  const shown = [
    { id: 'g-new-alpha', name: 'Alpha' },
    { id: 'g-beta', name: 'Beta' }
  ]
  it('the requested group when it is live', () => {
    expect(resumeTargetGroup([{ id: 'g-old', name: 'Beta' }], 'g-new-alpha', shown)).toBe(
      'g-new-alpha'
    )
  })
  it('else the LAST group the conversation lived in, matched by name across a relaunch', () => {
    const lived = [
      { id: 'g-old-beta', name: 'Beta' },
      { id: 'g-old-alpha', name: 'Alpha' }
    ]
    expect(resumeTargetGroup(lived, null, shown)).toBe('g-new-alpha')
    expect(resumeTargetGroup(lived, 'g-gone', shown)).toBe('g-new-alpha')
  })
  it('else the top level — never the ambient selection', () => {
    expect(resumeTargetGroup([{ id: 'g-old', name: 'Gamma' }], null, shown)).toBeNull()
    expect(resumeTargetGroup([], null, shown)).toBeNull()
  })
})

describe('visibleInWorkspace', () => {
  it('a stamped entry goes by its workspace id', () => {
    expect(visibleInWorkspace({ workspaceId: 'ws-1', cwd: '/x' }, 'ws-1', '/root')).toBe(true)
    expect(visibleInWorkspace({ workspaceId: 'ws-2', cwd: '/root/x' }, 'ws-1', '/root')).toBe(false)
  })
  it('an unstamped one goes by its own cwd against the root', () => {
    expect(visibleInWorkspace({ workspaceId: null, cwd: '/root/proj' }, 'ws-1', '/root')).toBe(true)
    expect(visibleInWorkspace({ workspaceId: null, cwd: '/root' }, 'ws-1', '/root')).toBe(true)
    expect(visibleInWorkspace({ workspaceId: null, cwd: '/rootling/proj' }, 'ws-1', '/root')).toBe(
      false
    )
    expect(visibleInWorkspace({ workspaceId: null, cwd: '/elsewhere' }, 'ws-1', '/root')).toBe(
      false
    )
  })
  it('no workspace: everything shows, stamped or not, root known or not', () => {
    expect(visibleInWorkspace({ workspaceId: null, cwd: '/anything' }, null, null)).toBe(true)
    expect(visibleInWorkspace({ workspaceId: 'ws-1', cwd: '/x' }, null, '/root')).toBe(true)
    expect(visibleInWorkspace({ workspaceId: null, cwd: '/elsewhere' }, 'ws-1', null)).toBe(true)
  })
  it('no cwd anywhere: the store dir name is the fallback, with its lossy prefix test', () => {
    expect(encodeProjectDir('/tmp/my.root')).toBe('-tmp-my-root')
    const e = (projectDir: string): { workspaceId: null; cwd: string; projectDir: string } => ({
      workspaceId: null,
      cwd: '',
      projectDir
    })
    expect(visibleInWorkspace(e('-tmp-my-root'), 'ws-1', '/tmp/my.root')).toBe(true)
    expect(visibleInWorkspace(e('-tmp-my-root-sub'), 'ws-1', '/tmp/my.root')).toBe(true)
    expect(visibleInWorkspace(e('-tmp-other'), 'ws-1', '/tmp/my.root')).toBe(false)
    expect(visibleInWorkspace(e('-tmp-my-rootling'), 'ws-1', '/tmp/my.root')).toBe(false)
    // No dir either: nothing to scope by, shown rather than hidden.
    expect(visibleInWorkspace({ workspaceId: null, cwd: '' }, 'ws-1', '/root')).toBe(true)
  })
})

describe('dotStateOf', () => {
  it("speaks the sidebar's words", () => {
    expect(dotStateOf(false, undefined)).toBe('closed')
    expect(dotStateOf(false, 'working')).toBe('closed')
    expect(dotStateOf(true, 'working')).toBe('working')
    expect(dotStateOf(true, 'blocked')).toBe('blocked')
    expect(dotStateOf(true, 'idle')).toBe('open')
    expect(dotStateOf(true, 'done')).toBe('open')
    expect(dotStateOf(true, undefined)).toBe('open')
  })
})
