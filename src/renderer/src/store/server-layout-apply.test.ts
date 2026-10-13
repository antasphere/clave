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
let adoptRecord: typeof import('../lib/adopt-record').adoptRecord
/** What main answers to `listSessionRecords`, set per test. */
let records: unknown[] = []
const recordsAsked: unknown[] = []
/** What the kernel lists (`sessionsList`): the id and the state of each session, set per test. */
let listed: { id: string; state: string }[] = []
let listedAnswer: (() => Promise<unknown[]>) | null = null

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
    sessionsList: async () => (listedAnswer ? listedAnswer() : listed),
    spawnSession: async (cwd: string, options: { adoptSessionId?: string }) => ({
      id: options.adoptSessionId,
      cwd,
      folderName: 'w',
      alive: true,
      claudeSessionId: null,
      piSessionId: null
    }),
    showNotification: async () => 'shown'
  }
  const store = await import('./session-store')
  useSessionStore = store.useSessionStore
  useWorkspaceStore = (await import('./workspace-store')).useWorkspaceStore
  applyServerLayout = store.applyServerLayout
  setSidebarBase = store.setSidebarBase
  adoptServerStartedTerminals = (await import('../lib/adopt-record')).adoptServerStartedTerminals
  adoptRecord = (await import('../lib/adopt-record')).adoptRecord
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
  knownGroups: Groups = groups,
  cause: 'save' | 'command' | 'move' | 'window-closed' | 'orphans' | undefined = 'command'
): void => {
  setSidebarBase({ windowKey: 'w', revision, groups: knownGroups, displayOrder: known })
  applyServerLayout({ windowKey: 'w', revision: ++revision, groups, displayOrder }, cause)
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
  listed = []
  listedAnswer = null
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

  it('leaves a tab that arrives with a move or a closing window to the re-home, and takes no focus for a save', async () => {
    const tab = (id: string): unknown => ({
      id,
      cwd: '/w',
      folderName: 'w',
      live: true,
      running: true,
      claudeMode: true,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false
    })
    records = [tab('moved')]
    // Main hands the layouts over before it detaches the sessions: at this
    // push the record still reads running, and the re-home's own adoption is
    // what must take the tab in, with the focus a close must not take.
    push([], ['moved'], [], [], 'window-closed')
    await new Promise((r) => setTimeout(r, 10))
    expect(recordsAsked).toEqual([])
    expect(useSessionStore.getState().sessions).toEqual([])
    push([], ['moved'], [], [], 'move')
    await new Promise((r) => setTimeout(r, 10))
    expect(recordsAsked).toEqual([])
    // A save, or a refused save's current layout, may name a tab this window
    // never saw: taken in, but the selection is an agent's placement's alone.
    push([], ['moved'], [], [], 'save')
    await new Promise((r) => setTimeout(r, 10))
    expect(recordsAsked).toEqual([{ ids: ['moved'] }])
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['moved'])
    expect(state.selectedSessionIds).toEqual([])
    expect(state.focusedSessionId).toBeNull()
  })

  it('leaves a group terminal that arrives with a closing window to the re-home, like a tab', async () => {
    const g = group(
      'g',
      [],
      [{ id: 't1', command: 'npm run dev', commandMode: 'auto', color: 'green', sessionId: 'term' }]
    )
    records = [
      {
        id: 'term',
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
    // The closing window's dev-server pane rides the re-home with its group:
    // a take-in here would adopt it, and select it, before the re-home does.
    push([], ['g'], [g], [], 'window-closed')
    await new Promise((r) => setTimeout(r, 10))
    expect(recordsAsked).toEqual([])
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('takes in a tab from a snapshot with no cause, selected nowhere', async () => {
    records = [
      {
        id: 'tab',
        cwd: '/w',
        folderName: 'w',
        live: true,
        running: true,
        claudeMode: true,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false
      }
    ]
    // A refused save's current layout, or the read after the restore: nobody's
    // change in particular, so the tab is taken in and nothing is selected.
    // Applied directly: the helper's default would read an absent cause as a command.
    setSidebarBase({ windowKey: 'w', revision, groups: [], displayOrder: [] })
    applyServerLayout({ windowKey: 'w', revision: ++revision, groups: [], displayOrder: ['tab'] })
    await new Promise((r) => setTimeout(r, 10))
    expect(recordsAsked).toEqual([{ ids: ['tab'] }])
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['tab'])
    expect(state.selectedSessionIds).toEqual([])
    expect(state.focusedSessionId).toBeNull()
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
    await adoptServerStartedTerminals(['b'], { focus: true })
    expect(useSessionStore.getState().focusedSessionId).toBeNull()
    records = [base('a', 'ws-shown')]
    await adoptServerStartedTerminals(['a'], { focus: true })
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
    await adoptServerStartedTerminals(['a'], { focus: true })
    expect(useSessionStore.getState().focusedSessionId).toBe('a')
    useSessionStore.setState({ selectedSessionIds: ['elsewhere'], focusedSessionId: 'elsewhere' })
    // Two pushes racing on the same id: the second lands after the first adopted it.
    await adoptServerStartedTerminals(['a'], { focus: true })
    expect(useSessionStore.getState().focusedSessionId).toBe('elsewhere')
    expect(useSessionStore.getState().sessions.filter((s) => s.id === 'a')).toHaveLength(1)
  })

  /** A visible group with one quick-launch terminal running `sid`, and the record main answers. */
  const shownTerminalGroup = (sid: string): Groups[number] => {
    const g = group(
      'g',
      [],
      [{ id: 't1', command: 'x', commandMode: 'auto', color: 'green', sessionId: sid }]
    )
    g.workspaceId = 'ws-shown'
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-shown' })
    records = [
      {
        id: sid,
        cwd: '/w',
        folderName: 'w',
        live: true,
        running: true,
        workspaceId: 'ws-shown',
        link: { kind: 'group-terminal', groupId: 'g', terminalId: 't1' },
        claudeMode: false,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false
      }
    ]
    return g
  }

  it("selects the terminal an agent's command took in, as the window's own launch would", async () => {
    const g = shownTerminalGroup('term')
    useSessionStore.setState({ sessions: [session('other')], displayOrder: ['other'] })
    push(['other'], ['g', 'other'], [g], [], 'command')
    await new Promise((r) => setTimeout(r, 10))
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id).sort()).toEqual(['other', 'term'])
    expect(state.focusedSessionId).toBe('term')
  })

  it('takes in but does not select a terminal that arrives with a save: only a command selects (PRDCT-3428)', async () => {
    const g = shownTerminalGroup('term')
    useSessionStore.setState({
      sessions: [session('other')],
      displayOrder: ['other'],
      selectedSessionIds: ['other'],
      focusedSessionId: 'other'
    })
    push(['other'], ['g', 'other'], [g], [], 'save')
    await new Promise((r) => setTimeout(r, 10))
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id).sort()).toEqual(['other', 'term'])
    expect(state.focusedSessionId).toBe('other')
    expect(state.selectedSessionIds).toEqual(['other'])
  })

  it('takes in but does not select a terminal from a snapshot with no cause (the refused save, the catch-up)', async () => {
    const g = shownTerminalGroup('term')
    useSessionStore.setState({ sessions: [], displayOrder: [] })
    setSidebarBase({ windowKey: 'w', revision, groups: [], displayOrder: [] })
    applyServerLayout({ windowKey: 'w', revision: ++revision, groups: [g], displayOrder: ['g'] })
    await new Promise((r) => setTimeout(r, 10))
    const state = useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['term'])
    expect(state.focusedSessionId).toBeNull()
    expect(state.selectedSessionIds).toEqual([])
  })

  it('paints the state the kernel holds for a tab the server opened, at once (PRDCT-3289)', async () => {
    records = [
      {
        id: 'opened',
        cwd: '/w',
        folderName: 'w',
        live: true,
        running: true,
        claudeMode: true,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false
      }
    ]
    listed = [{ id: 'opened', state: 'working' }]
    push([], ['opened'])
    await new Promise((r) => setTimeout(r, 10))
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'opened')?.agentState).toBe(
      'working'
    )
  })

  it("paints the kernel's state on a tab adopted from its record, and never over a word heard live", async () => {
    const record = {
      id: 'r1',
      cwd: '/w',
      folderName: 'w',
      live: true,
      tmuxName: 'clave-r1',
      claudeMode: true,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false
    } as never
    listed = [{ id: 'r1', state: 'blocked' }]
    await adoptRecord(record, null)
    await new Promise((r) => setTimeout(r, 10))
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'r1')?.agentState).toBe(
      'blocked'
    )
    // A second tab: the hook's word lands while the kernel's list is still in flight; the live word stays.
    const pending: { answer: ((value: unknown[]) => void) | null } = { answer: null }
    listedAnswer = () => new Promise<unknown[]>((resolve) => (pending.answer = resolve))
    const r2 = { ...(record as object), id: 'r2', tmuxName: 'clave-r2' } as never
    const adopting = adoptRecord(r2, null)
    await new Promise((r) => setTimeout(r, 10))
    useSessionStore.getState().setAgentState('r2', 'done')
    pending.answer?.([{ id: 'r2', state: 'working' }])
    await adopting
    await new Promise((r) => setTimeout(r, 10))
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'r2')?.agentState).toBe('done')
  })

  it("seeds nothing from a kernel word of 'ended' or from a session the kernel does not list", async () => {
    const tab = (id: string): unknown => ({
      id,
      cwd: '/w',
      folderName: 'w',
      live: true,
      running: true,
      claudeMode: true,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false
    })
    records = [tab('gone'), tab('unlisted')]
    listed = [{ id: 'gone', state: 'ended' }]
    push([], ['gone', 'unlisted'])
    await new Promise((r) => setTimeout(r, 10))
    const state = useSessionStore.getState()
    expect(state.sessions.find((s) => s.id === 'gone')?.agentState).toBeUndefined()
    expect(state.sessions.find((s) => s.id === 'unlisted')?.agentState).toBeUndefined()
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

describe('the shells a restore kept are settled by the store (PRDCT-3432)', () => {
  it('drops the candidates that are no session, group or file tab now, and keeps the rest', () => {
    const g = group(
      'g',
      ['back', 'gone'],
      [{ id: 't1', command: 'x', commandMode: 'auto', color: 'green', sessionId: 'term-gone' }]
    )
    useSessionStore.setState({
      sessions: [session('back'), session('top-back')],
      groups: [g],
      fileTabs: [{ id: 'file-1', path: '/w/README.md', name: 'README.md' } as never],
      displayOrder: ['g', 'top-back', 'top-gone', 'file-1']
    })
    useSessionStore
      .getState()
      .pruneRestoredShells(['back', 'gone', 'term-gone', 'top-back', 'top-gone', 'file-1'])
    const state = useSessionStore.getState()
    expect(state.groups[0].sessionIds).toEqual(['back'])
    expect(state.groups[0].terminals[0].sessionId).toBeNull()
    // A file tab is held by the store too: a candidate naming one is kept (round-1 verifier G1).
    expect(state.displayOrder).toEqual(['g', 'top-back', 'file-1'])
  })

  it('changes nothing, not even the references, when every candidate is held', () => {
    const g = group('g', ['back'])
    useSessionStore.setState({ sessions: [session('back')], groups: [g], displayOrder: ['g'] })
    const before = useSessionStore.getState()
    useSessionStore.getState().pruneRestoredShells(['back', 'g'])
    const after = useSessionStore.getState()
    expect(after.groups).toBe(before.groups)
    expect(after.displayOrder).toBe(before.displayOrder)
  })
})
