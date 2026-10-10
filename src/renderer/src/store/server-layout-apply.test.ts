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
        running: true,
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

  it('takes in a TAB the server opened, from its record, selected; leaves one that is not running', async () => {
    const tab = (id: string, running: boolean): unknown => ({
      id,
      cwd: '/w',
      folderName: 'w',
      displayName: `Tab ${id}`,
      live: true,
      running,
      claudeMode: true,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false
    })
    records = [tab('opened', true), tab('moving', false)]
    // The server placed two ids this window never saw: one it runs, one
    // detached on its way here (the re-home's to reattach).
    push([], ['opened', 'moving'])
    await new Promise((r) => setTimeout(r, 10))
    const state = useSessionStore.getState()
    expect(recordsAsked).toEqual([{ ids: ['opened', 'moving'] }])
    expect(state.sessions.map((s) => s.id)).toEqual(['opened'])
    expect(state.sessions[0]).toMatchObject({ name: 'Tab opened', claudeMode: true })
    expect(state.selectedSessionIds).toEqual(['opened'])
    expect(state.focusedSessionId).toBe('opened')
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
      running: true,
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

  it('does not take a terminal in twice: a second adoption of a known id steals no focus', async () => {
    const g = group(
      'g',
      [],
      [{ id: 't1', command: 'x', commandMode: 'auto', color: 'green', sessionId: 'a' }]
    )
    g.workspaceId = 'ws-shown'
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-shown' })
    useSessionStore.setState({
      sessions: [session('elsewhere')],
      groups: [g],
      displayOrder: ['g', 'elsewhere']
    })
    records = [
      {
        id: 'a',
        cwd: '/w',
        folderName: 'w',
        live: true,
        running: true,
        workspaceId: 'ws-shown',
        claudeMode: false,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false
      }
    ]
    await adoptServerStartedTerminals(['a'])
    expect(useSessionStore.getState().focusedSessionId).toBe('a')
    useSessionStore.setState({ selectedSessionIds: ['elsewhere'], focusedSessionId: 'elsewhere' })
    // Two pushes racing on the same id: the second lands after the first adopted it.
    await adoptServerStartedTerminals(['a'])
    expect(useSessionStore.getState().focusedSessionId).toBe('elsewhere')
    expect(useSessionStore.getState().sessions.filter((s) => s.id === 'a')).toHaveLength(1)
  })

  it('takes a terminal in as ended when its record says its process is gone', async () => {
    const g = group(
      'g',
      [],
      [{ id: 't1', command: 'exit 0', commandMode: 'auto', color: 'green', sessionId: 'dead' }]
    )
    useSessionStore.setState({ groups: [g], displayOrder: ['g'] })
    records = [
      {
        id: 'dead',
        cwd: '/w',
        folderName: 'w',
        live: false,
        running: true,
        claudeMode: false,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false
      }
    ]
    await adoptServerStartedTerminals(['dead'])
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'dead')?.alive).toBe(false)
  })

  it('leaves a terminal detached from another window to the re-home: no record main runs, nothing taken in', async () => {
    const g = group(
      'g',
      [],
      [
        {
          id: 't1',
          command: 'npm run dev',
          commandMode: 'auto',
          color: 'green',
          sessionId: 'moving'
        }
      ]
    )
    g.workspaceId = 'ws-shown'
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-shown' })
    useSessionStore.setState({
      sessions: [session('member')],
      groups: [g],
      displayOrder: ['g', 'member'],
      focusedSessionId: 'member',
      selectedSessionIds: ['member']
    })
    // An adoptable record (tmux alive, no `running`): the move's own adoption reattaches it.
    records = [
      {
        id: 'moving',
        cwd: '/w',
        folderName: 'w',
        live: true,
        tmuxName: 'clave-x',
        claudeMode: false,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false
      }
    ]
    await adoptServerStartedTerminals(['moving'])
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['member'])
    expect(state.focusedSessionId).toBe('member')
  })
})
