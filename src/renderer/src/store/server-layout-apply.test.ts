/**
 * What the window does with a layout the server pushes (wave 3, the agent
 * tools served by the server): a tab the layout no longer places stays
 * drawn while its process lives (appended at the top level, as before), and
 * leaves the store once its process has ended (an agent's close through the
 * server), taking the serving session of its view with it; a tab a linked
 * editor refuses to close is kept whatever its state. The store reads
 * localStorage and the preload bridge at import time, so both are stubbed
 * first, as group-dissolve.test.ts does; the linked-document store is
 * replaced by a switch the test flips.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from './session-types'

let blocksClose = false
vi.mock('./linked-document-store', () => ({
  linkedEditorBlocksClose: () => blocksClose
}))

let useSessionStore: typeof import('./session-store').useSessionStore
let useWorkspaceStore: typeof import('./workspace-store').useWorkspaceStore
let applyServerLayout: typeof import('./session-store').applyServerLayout
let setSidebarBase: typeof import('./session-store').setSidebarBase
let adoptServerStartedTerminals: typeof import('../lib/adopt-record').adoptServerStartedTerminals
/** What main answers to `listSessionRecords`, set per test. */
let records: unknown[] = []
const recordsAsked: unknown[] = []

beforeAll(async () => {
  const mem = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k)
  }
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
    killSession: async () => undefined,
    captureTabClosed: () => {},
    listSessionRecords: async (filter: unknown) => {
      recordsAsked.push(filter)
      return records
    },
    showNotification: async () => 'shown'
  }
  const store = await import('./session-store')
  useSessionStore = store.useSessionStore
  useWorkspaceStore = (await import('./workspace-store')).useWorkspaceStore
  applyServerLayout = store.applyServerLayout
  setSidebarBase = store.setSidebarBase
  adoptServerStartedTerminals = (await import('../lib/adopt-record')).adoptServerStartedTerminals
})

const session = (id: string, alive = true, extra: Partial<Session> = {}): Session =>
  ({
    id,
    cwd: '/w',
    folderName: 'w',
    name: id,
    alive,
    activityStatus: 'idle',
    promptWaiting: null,
    claudeMode: false,
    antigravityMode: false,
    codexMode: false,
    dangerousMode: false,
    claudeSessionId: null,
    sessionType: 'local',
    detectedUrl: null,
    serverStatus: null,
    serverCommand: null,
    hasUnseenActivity: false,
    userRenamed: false,
    planFilePath: null,
    ...extra
  }) as Session

let revision = 0
type Groups = import('./session-types').SessionGroup[]
/** The window knew the server's layout as `known`; the server now pushes `displayOrder`. */
const push = (
  known: string[],
  displayOrder: string[],
  groups: Groups = [],
  knownGroups: Groups = groups
): void => {
  setSidebarBase({ windowKey: 'w', revision, groups: knownGroups, displayOrder: known })
  applyServerLayout({ windowKey: 'w', revision: ++revision, groups, displayOrder })
}
const group = (
  id: string,
  sessionIds: string[],
  terminals: Groups[number]['terminals'] = []
): Groups[number] =>
  ({ id, name: id, sessionIds, collapsed: false, cwd: null, terminals }) as Groups[number]

beforeEach(() => {
  blocksClose = false
  records = []
  recordsAsked.length = 0
  useSessionStore.setState({
    sessions: [],
    groups: [],
    displayOrder: [],
    selectedSessionIds: [],
    focusedSessionId: null,
    fileTabs: []
  })
})

describe('a layout pushed by the server', () => {
  it('keeps a live tab the layout does not place, appended at the top level', () => {
    useSessionStore.setState({ sessions: [session('live')], displayOrder: ['live'] })
    push(['live'], [])
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['live'])
    expect(state.displayOrder).toEqual(['live'])
  })

  it('drops an ended tab the layout no longer places, with the serving session of its view', () => {
    useSessionStore.setState({
      sessions: [
        session('closed', false, {
          view: { url: 'http://127.0.0.1:1', serverSessionId: 'serving' }
        }),
        session('serving'),
        session('other')
      ],
      displayOrder: ['closed', 'other'],
      selectedSessionIds: ['closed'],
      focusedSessionId: 'closed'
    })
    push(['closed', 'other'], ['other'])
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['other'])
    expect(state.displayOrder).toEqual(['other'])
    expect(state.selectedSessionIds).toEqual([])
    expect(state.focusedSessionId).toBeNull()
  })

  it('keeps an ended tab the layout still places', () => {
    useSessionStore.setState({ sessions: [session('ended', false)], displayOrder: ['ended'] })
    push(['ended'], ['ended'])
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['ended'])
  })

  it('keeps an ended, unplaced tab a linked editor refuses to close', () => {
    blocksClose = true
    useSessionStore.setState({ sessions: [session('editing', false)], displayOrder: ['editing'] })
    push(['editing'], [])
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['editing'])
    expect(state.displayOrder).toEqual(['editing'])
  })

  it('keeps an ended tab inside a group: a member is placed by its group, not by the order', () => {
    const g = group('g', ['member'])
    useSessionStore.setState({
      sessions: [session('member', false)],
      groups: [g],
      displayOrder: ['g']
    })
    push(['g'], ['g'], [g])
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['member'])
    expect(state.groups[0].sessionIds).toEqual(['member'])
  })

  it('takes in the session of a terminal the server started, from its record, without a spawn', async () => {
    const g = group(
      'g',
      [],
      [
        {
          id: 't1',
          command: 'npm run dev',
          commandMode: 'auto',
          color: 'green',
          sessionId: 'served'
        }
      ]
    )
    records = [
      {
        id: 'served',
        cwd: '/w',
        folderName: 'w',
        live: true,
        link: { kind: 'group-terminal', groupId: 'g', terminalId: 't1' },
        claudeMode: false,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false
      }
    ]
    useSessionStore.setState({ groups: [], displayOrder: [] })
    // The window knew an empty layout; the server now holds the group.
    push([], ['g'], [g], [])
    await new Promise((r) => setTimeout(r, 10))
    const state = useSessionStore.getState()
    expect(recordsAsked).toEqual([{ ids: ['served'] }])
    expect(state.sessions.map((s) => s.id)).toEqual(['served'])
    expect(state.displayOrder).toEqual(['g'])
    // Asked once: a session the store holds is not fetched again on the next push.
    push(['g'], ['g'], [g])
    await new Promise((r) => setTimeout(r, 10))
    expect(recordsAsked).toHaveLength(1)
  })

  it('selects the taken-in terminal only when its group shows on screen', async () => {
    const shown = group(
      'g',
      [],
      [{ id: 't1', command: 'x', commandMode: 'auto', color: 'green', sessionId: 'a' }]
    )
    shown.workspaceId = 'ws-shown'
    const hidden = group(
      'h',
      [],
      [{ id: 't2', command: 'y', commandMode: 'auto', color: 'green', sessionId: 'b' }]
    )
    hidden.workspaceId = 'ws-hidden'
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-shown' })
    useSessionStore.setState({ groups: [shown, hidden], displayOrder: ['g', 'h'] })
    const base = (id: string, ws: string): Record<string, unknown> => ({
      id,
      cwd: '/w',
      folderName: 'w',
      live: true,
      workspaceId: ws,
      claudeMode: false,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false
    })
    records = [base('b', 'ws-hidden')]
    await adoptServerStartedTerminals(['b'])
    expect(useSessionStore.getState().focusedSessionId).toBeNull()
    records = [base('a', 'ws-shown')]
    await adoptServerStartedTerminals(['a'])
    expect(useSessionStore.getState().focusedSessionId).toBe('a')
    expect(
      useSessionStore
        .getState()
        .sessions.map((s) => s.id)
        .sort()
    ).toEqual(['a', 'b'])
  })
})
