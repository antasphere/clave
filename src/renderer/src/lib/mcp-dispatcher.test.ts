import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
/* The stores the dispatcher imports read localStorage and window as they load
   (the unit suite runs in node, with no DOM package), so both exist before the
   first import; the preload bridge is the one thing a test supplies. */
const globals = vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    }
  }
  const window = { localStorage, electronAPI: {} as Record<string, unknown> }
  Object.assign(globalThis, { localStorage, window })
  return { window }
})
import { useLaunchProfileStore } from '../store/launch-profile-store'
import type { LaunchProfile, LaunchProfilePreferences } from '../../../shared/agent-launch'

/* The window road of clave_open_session: the renderer's own executor, the one
   a Mac with a saved server connection runs every open through (and the only
   one FileTree reaches). It is reached by no end-to-end spec (the per-tab
   endpoint serves the open in main unless a fleet server is saved), so the
   chat it picks is pinned here: the chat the launcher would open, the
   workspace's or global default's chat form, read from the Mac's own store. */

const switchAccount = vi.hoisted(() => ({
  restartSessionProcess: vi.fn(async (id: string) => ({ ok: id !== '', resumed: true }))
}))
vi.mock('./switch-account', () => ({
  restartSessionProcess: switchAccount.restartSessionProcess,
  resolveAccountForSpawn: () => ({ id: 'default', label: 'Default' }),
  resolveAccountRef: () => ({ id: 'default', label: 'Default' }),
  claudeProfileSpawnFields: () => ({}),
  codexAccountSpawnFields: () => ({ codexAccountId: 'default', codexAccountLabel: 'Default' }),
  sessionAccountExhausted: () => false,
  switchSessionAccount: vi.fn()
}))
import { openSessionProgrammatically, initMcpDispatcher } from './mcp-dispatcher'
import { usePinnedStore } from '../store/pinned-store'
import { resourceKey } from '@clave/contract/fleet'

import { useWorkspaceStore } from '../store/workspace-store'
import { useSessionStore } from '../store/session-store'
import { useFleetStore } from '../store/fleet-store'
import { usePairingStore } from '../store/pairing-store'
const codex = (id: string, name: string, flags: string[] = []): LaunchProfile => ({
  id,
  name,
  family: 'codex' as const,
  command: ['codex', ...flags],
  additionalArgs: []
})
/** The preferences as the host lists them: the saved profiles and their
 *  chat forms, the built-in chat beside them. */
const preferences = (over: Partial<LaunchProfilePreferences>): LaunchProfilePreferences => ({
  version: 1,
  customProfiles: [
    codex('yolo', 'yolo codex', ['--yolo']),
    { ...codex('chat:codex:yolo', 'yolo codex (chat)', ['--yolo']), sourceProfileId: 'yolo' },
    { ...codex('codex-chat', 'Codex (chat)'), builtIn: true }
  ],
  globalDefaults: {},
  workspaceOverrides: {},
  ...over
})

let spawnSession: ReturnType<typeof vi.fn>
beforeEach(() => {
  spawnSession = vi.fn(async (cwd: string, options: Record<string, unknown>) => ({
    id: `tab-${spawnSession.mock.calls.length}`,
    cwd,
    folderName: 'repo',
    alive: true,
    launchProfileId: options.launchProfileId
  }))
  globals.window.electronAPI = { spawnSession, captureTabSpawn: vi.fn() }
})
afterEach(() => {
  globals.window.electronAPI = {}
  useWorkspaceStore.setState({ workspaces: [], serverWorkspaces: {}, activeWorkspaceId: null })
  useSessionStore.setState({ sessions: [], groups: [] })
  usePinnedStore.setState({ pinnedGroups: [] })
  useLaunchProfileStore.setState({ preferences: preferences({}), loaded: true })
})

const spawned = (): Record<string, unknown> => spawnSession.mock.calls.at(-1)![1]

describe('clave_open_session on the window road', () => {
  it('uses a legacy background caller workspace on the fleet window road', async () => {
    useWorkspaceStore.setState({
      activeWorkspaceId: 'other',
      workspaces: [
        { id: 'home', name: 'Home', rootDir: '/home-project', profileFile: null, createdAt: 1 },
        { id: 'other', name: 'Other', rootDir: '/other', profileFile: null, createdAt: 1 }
      ]
    })
    useSessionStore.setState({ sessions: [{ id: 'caller', cwd: '/home-project/work' } as never] })
    try {
      await openSessionProgrammatically({
        cwd: '/outside',
        mode: 'codex',
        callerSessionId: 'caller'
      })
      expect(spawned()).toMatchObject({ workspaceId: 'home' })
    } finally {
      useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null })
      useSessionStore.setState({ sessions: [] })
    }
  })

  it("opens a chat on the global default's chat form, the one the launcher would open", async () => {
    useLaunchProfileStore.setState({
      preferences: preferences({ globalDefaults: { codex: 'yolo' } }),
      loaded: true
    })
    await openSessionProgrammatically({ cwd: '/repo', mode: 'codex', chat: true })
    expect(spawned()).toMatchObject({
      codexMode: true,
      dangerousMode: false,
      launchProfileId: 'chat:codex:yolo'
    })
  })
  it('opens the built-in chat when nothing is set, and an explicit chat profile wins', async () => {
    useLaunchProfileStore.setState({ preferences: preferences({}), loaded: true })
    await openSessionProgrammatically({ cwd: '/repo', mode: 'codex', chat: true })
    expect(spawned()).toMatchObject({ launchProfileId: 'codex-chat' })
    useLaunchProfileStore.setState({
      preferences: preferences({ globalDefaults: { codex: 'yolo' } }),
      loaded: true
    })
    await openSessionProgrammatically({
      cwd: '/repo',
      mode: 'codex',
      chat: true,
      profile: 'codex-chat',
      dangerous: true
    })
    expect(spawned()).toMatchObject({ launchProfileId: 'codex-chat', dangerousMode: true })
  })
  it('a past conversation reopened carries its id to the spawn, and only then (PRDCT-4236)', async () => {
    await openSessionProgrammatically({ cwd: '/repo', mode: 'claude', resumeSessionId: 'abc' })
    expect(spawned().resumeSessionId).toBe('abc')
    await openSessionProgrammatically({ cwd: '/repo', mode: 'claude' })
    expect(spawned()).not.toHaveProperty('resumeSessionId')
  })
  it('refuses a terminal profile beside chat, and leaves a terminal open untouched by the chat rule', async () => {
    useLaunchProfileStore.setState({
      preferences: preferences({ globalDefaults: { codex: 'yolo' } }),
      loaded: true
    })
    await expect(
      openSessionProgrammatically({ cwd: '/repo', mode: 'codex', chat: true, profile: 'yolo' })
    ).rejects.toThrow(/drop profile/)
    await openSessionProgrammatically({ cwd: '/repo', mode: 'codex', profile: 'yolo' })
    expect(spawned()).toMatchObject({ launchProfileId: 'yolo', codexMode: true })
  })
})

const legacyCaller = (): void => {
  useWorkspaceStore.setState({
    activeWorkspaceId: 'other',
    workspaces: [
      { id: 'home', name: 'Home', rootDir: '/home-project', profileFile: null, createdAt: 1 },
      { id: 'other', name: 'Other', rootDir: '/other', profileFile: null, createdAt: 1 }
    ]
  })
  useSessionStore.setState({
    sessions: [{ id: 'caller', cwd: '/home-project/work' } as never],
    groups: [
      {
        id: 'g-home',
        name: 'Build',
        workspaceId: 'home',
        sessionIds: [],
        terminals: [],
        collapsed: false,
        cwd: null
      },
      {
        id: 'g-other',
        name: 'Build',
        workspaceId: 'other',
        sessionIds: [],
        terminals: [],
        collapsed: false,
        cwd: null
      }
    ]
  })
}
it('chooses the legacy caller group when group names match across workspaces', async () => {
  legacyCaller()
  await openSessionProgrammatically({
    cwd: '/outside',
    mode: 'codex',
    callerSessionId: 'caller',
    groupId: 'Build'
  })
  expect(useSessionStore.getState().groups.find((g) => g.id === 'g-home')?.sessionIds).toContain(
    'tab-1'
  )
  expect(spawned()).toMatchObject({ workspaceId: 'home' })
})
it('does not infer a local caller workspace from a server path', async () => {
  legacyCaller()
  const serverWs = resourceKey('workspace', 'server', 'same-path')
  useWorkspaceStore.setState({
    serverWorkspaces: {
      server: [
        {
          id: serverWs,
          name: 'Remote',
          rootDir: '/home-project/work',
          profileFile: null,
          createdAt: 1
        }
      ]
    }
  })
  await openSessionProgrammatically({ cwd: '/outside', mode: 'codex', callerSessionId: 'caller' })
  expect(spawned()).toMatchObject({ workspaceId: 'home' })
})
it('launches the legacy caller pinned group when pinned names match across workspaces', async () => {
  legacyCaller()
  usePinnedStore.setState({
    pinnedGroups: [
      {
        id: 'pin-home',
        name: 'Build',
        workspaceId: 'home',
        activeGroupId: 'g-home',
        visible: true
      } as never,
      {
        id: 'pin-other',
        name: 'Build',
        workspaceId: 'other',
        activeGroupId: 'g-other',
        visible: true
      } as never
    ]
  })
  let receive: (msg: { requestId: string; command: string; payload: unknown }) => void = () => {}
  const response = new Promise<{ result?: unknown; ok: boolean }>((resolve) => {
    globals.window.electronAPI.onMcpCommand = (handler: typeof receive) => {
      receive = handler
      return () => {}
    }
    globals.window.electronAPI.mcpRespond = resolve
  })
  const unsubscribe = initMcpDispatcher()
  receive({
    requestId: 'pin',
    command: 'launchGroup',
    payload: { group: 'Build', callerSessionId: 'caller' }
  })
  expect(await response).toMatchObject({ ok: true, result: { pinnedId: 'pin-home' } })
  unsubscribe()
})

/* The work tools on the window road (PRDCT-4123): a call the server does not
   serve reads its arguments as the server's road does, keeps this store's
   reach rule, and sends the change through the preload. The served road is
   pinned in served-work-tools.test.ts; this road had no test. */
describe('clave_set_work and clave_hand_over on the window road', () => {
  const work = {
    unit: 'lane-a',
    kind: 'lane',
    label: 'Pair the phone',
    role: 'lead',
    standing: 'current',
    joinedAt: 10,
    since: 10
  }
  let sessionsChangeWork: ReturnType<typeof vi.fn>
  /** One command as main sends it to this window, and the window's answer. */
  const dispatch = async (
    command: string,
    payload: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    let receive: (msg: { requestId: string; command: string; payload: unknown }) => void = () => {}
    const response = new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
      globals.window.electronAPI.onMcpCommand = (handler: typeof receive) => {
        receive = handler
        return () => {}
      }
      globals.window.electronAPI.mcpRespond = resolve
    })
    const unsubscribe = initMcpDispatcher()
    receive({ requestId: command, command, payload })
    try {
      return await response
    } finally {
      unsubscribe()
    }
  }
  beforeEach(() => {
    sessionsChangeWork = vi.fn(async () => ({ changed: [], renamed: [] }))
    globals.window.electronAPI.sessionsChangeWork = sessionsChangeWork
    // The caller leads lane A; a mate shares its group; a stranger shares
    // nothing with it: no parent link, no group.
    useSessionStore.setState({
      sessions: [
        { id: 'caller', name: 'Lead', sessionType: 'local', work } as never,
        { id: 'mate', name: 'Mate', sessionType: 'local' } as never,
        { id: 'stranger', name: 'Stranger', sessionType: 'local' } as never
      ],
      groups: [
        {
          id: 'g-lane',
          name: 'Lane A',
          sessionIds: ['caller', 'mate'],
          terminals: [],
          collapsed: false,
          cwd: null
        }
      ]
    })
  })

  it('assigns a tab the caller is not related to (PRDCT-4236)', async () => {
    const answer = await dispatch('setWork', {
      callerSessionId: 'caller',
      sessionId: 'stranger',
      role: 'verifier'
    })
    expect(answer.ok).toBe(true)
    expect(sessionsChangeWork).toHaveBeenCalledTimes(1)
    expect(sessionsChangeWork.mock.calls[0][0]).toBe('stranger')
  })

  it('refuses a work change with no tab identity, before any change', async () => {
    const answer = await dispatch('setWork', { sessionId: 'stranger', role: 'verifier' })
    expect(answer.ok).toBe(false)
    expect(answer.error).toMatch(/no tab identity/)
    expect(sessionsChangeWork).not.toHaveBeenCalled()
  })

  it("assigns a tab of the caller's group to the caller's own unit when none is named", async () => {
    const answer = await dispatch('setWork', {
      callerSessionId: 'caller',
      sessionId: 'mate',
      role: 'verifier'
    })
    expect(answer).toMatchObject({ ok: true, result: { sessionId: 'mate' } })
    expect(sessionsChangeWork).toHaveBeenCalledTimes(1)
    expect(sessionsChangeWork).toHaveBeenCalledWith('mate', {
      type: 'assign',
      work: { unit: 'lane-a', role: 'verifier' }
    })
  })

  it("offers the caller's role to a tab of its group", async () => {
    const answer = await dispatch('handOver', { callerSessionId: 'caller', to: 'mate' })
    expect(answer).toMatchObject({ ok: true, result: { sessionId: 'caller' } })
    expect(sessionsChangeWork).toHaveBeenCalledTimes(1)
    expect(sessionsChangeWork).toHaveBeenCalledWith('caller', { type: 'offer', to: 'mate' })
  })

  it('refuses a hand over that both names a successor and accepts', async () => {
    const answer = await dispatch('handOver', {
      callerSessionId: 'caller',
      to: 'mate',
      accept: true
    })
    expect(answer.ok).toBe(false)
    expect(answer.error).toMatch(/exactly one of/)
    expect(sessionsChangeWork).not.toHaveBeenCalled()
  })
})

/* A stopped tab, on the window's road (PRDCT-4193): clave_resume_session and
   resume: true on clave_send_to_session bring it back through the same
   restart the tab's Resume button makes, never silently; the reach rule keeps
   main's lineage across a window reload; a server tab's serving terminal is
   started on that server. */
describe('resume and reach on the window road (PRDCT-4193)', () => {
  const agent = (id: string, over: Record<string, unknown> = {}): never =>
    ({
      id,
      name: id,
      cwd: '/repo',
      sessionType: 'local',
      alive: true,
      claudeMode: true,
      ...over
    }) as never
  let sessionsWrite: ReturnType<typeof vi.fn>
  let fleetSnapshot: ReturnType<typeof vi.fn>
  /** One command through a freshly initialised dispatcher, after main's
   *  lineage (when given) has been read. */
  const dispatch = async (
    command: string,
    payload: Record<string, unknown>,
    lineage: Record<string, string> = {}
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    let receive: (msg: { requestId: string; command: string; payload: unknown }) => void = () => {}
    const response = new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
      globals.window.electronAPI.onMcpCommand = (handler: typeof receive) => {
        receive = handler
        return () => {}
      }
      globals.window.electronAPI.mcpRespond = resolve
    })
    globals.window.electronAPI.lineageParents = vi.fn(async () => lineage)
    const unsubscribe = initMcpDispatcher()
    await new Promise((r) => setTimeout(r, 0))
    receive({ requestId: command, command, payload })
    try {
      return await response
    } finally {
      unsubscribe()
    }
  }
  beforeEach(() => {
    switchAccount.restartSessionProcess.mockReset()
    // The restart marks the tab alive, as the real one does once the
    // process is back, so a delivery after it sees a live target.
    switchAccount.restartSessionProcess.mockImplementation(async (id: string) => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, alive: true } : s))
      }))
      return { ok: true, resumed: true } as const
    })
    sessionsWrite = vi.fn(async () => undefined)
    fleetSnapshot = vi.fn(async () => undefined)
    Object.assign(globals.window.electronAPI, {
      sessionsWrite,
      fleetSnapshot,
      sessionsList: vi.fn(async () =>
        useSessionStore.getState().sessions.map((s) => ({ id: s.id, transport: 'events' }))
      ),
      captureExchangeMessage: vi.fn()
    })
  })

  it('refuses to resume a running tab, before any restart', async () => {
    useSessionStore.setState({
      sessions: [agent('r-lead'), agent('r-child', { spawnedBy: 'r-lead' })]
    })
    const answer = await dispatch('resumeSession', {
      callerSessionId: 'r-lead',
      sessionId: 'r-child'
    })
    expect(answer).toMatchObject({
      ok: false,
      error: 'Session "r-child" is running; there is nothing to resume.'
    })
    expect(switchAccount.restartSessionProcess).not.toHaveBeenCalled()
  })

  it('resumes a stopped tab the caller opened, and answers what came back', async () => {
    useSessionStore.setState({
      sessions: [agent('r-lead'), agent('r-child', { spawnedBy: 'r-lead', alive: false })]
    })
    const answer = await dispatch('resumeSession', {
      callerSessionId: 'r-lead',
      sessionId: 'r-child'
    })
    expect(switchAccount.restartSessionProcess).toHaveBeenCalledWith('r-child', {
      onlyIfStopped: true
    })
    expect(answer).toMatchObject({ ok: true })
    expect(answer.result).toEqual({
      resumed: true,
      sessionId: 'r-child',
      name: 'r-child',
      mode: 'claude',
      alive: true,
      conversation: true
    })
    // A Mac tab: no server snapshot to read again.
    expect(fleetSnapshot).not.toHaveBeenCalled()
  })

  it('reads the server again after resuming a tab of a Clave server', async () => {
    const remote = resourceKey('session', 'srv', 'child')
    useSessionStore.setState({
      sessions: [agent('r-lead'), agent(remote, { spawnedBy: 'r-lead', alive: false })]
    })
    const answer = await dispatch('resumeSession', { callerSessionId: 'r-lead', sessionId: remote })
    expect(answer.ok).toBe(true)
    expect(switchAccount.restartSessionProcess).toHaveBeenCalledWith(remote, {
      onlyIfStopped: true
    })
    expect(fleetSnapshot).toHaveBeenCalledWith('srv')
  })

  it('resumes a tab the caller is not related to (PRDCT-4236)', async () => {
    useSessionStore.setState({ sessions: [agent('r-lead'), agent('r-other', { alive: false })] })
    const answer = await dispatch('resumeSession', {
      callerSessionId: 'r-lead',
      sessionId: 'r-other'
    })
    expect(answer).toMatchObject({ ok: true, result: { resumed: true, sessionId: 'r-other' } })
    expect(switchAccount.restartSessionProcess).toHaveBeenCalledWith('r-other', {
      onlyIfStopped: true
    })
  })

  it('refuses a resume with no tab identity, and restarts nothing', async () => {
    useSessionStore.setState({ sessions: [agent('r-lead'), agent('r-other', { alive: false })] })
    const answer = await dispatch('resumeSession', { sessionId: 'r-other' })
    expect(answer).toMatchObject({
      ok: false,
      error:
        'clave_resume_session must be called from inside a Clave agent tab — this request has no tab identity.'
    })
    expect(switchAccount.restartSessionProcess).not.toHaveBeenCalled()
  })

  it('refuses a message to an ended tab with the way to resume it, and never restarts it', async () => {
    useSessionStore.setState({
      sessions: [agent('s-lead'), agent('s-child', { spawnedBy: 's-lead', alive: false })]
    })
    const answer = await dispatch('sendToSession', {
      callerSessionId: 's-lead',
      sessionId: 's-child',
      message: 'hello'
    })
    expect(answer).toMatchObject({
      ok: false,
      error:
        'Session "s-child" has ended; resume it with clave_resume_session, or pass resume: true to resume it and deliver.'
    })
    expect(switchAccount.restartSessionProcess).not.toHaveBeenCalled()
    expect(sessionsWrite).not.toHaveBeenCalled()
  })

  it('with resume: true, resumes the ended tab first and then delivers', async () => {
    useSessionStore.setState({
      sessions: [agent('s-lead'), agent('s-child', { spawnedBy: 's-lead', alive: false })]
    })
    const answer = await dispatch('sendToSession', {
      callerSessionId: 's-lead',
      sessionId: 's-child',
      message: 'hello',
      resume: true
    })
    expect(answer).toMatchObject({ ok: true, result: { delivered: true, sessionId: 's-child' } })
    expect(switchAccount.restartSessionProcess).toHaveBeenCalledWith('s-child', {
      onlyIfStopped: true
    })
    expect(sessionsWrite).toHaveBeenCalledTimes(1)
    expect(sessionsWrite.mock.calls[0][0]).toBe('s-child')
    expect(sessionsWrite.mock.calls[0][1]).toMatchObject({ type: 'user_message' })
    expect(sessionsWrite.mock.calls[0][1].text).toContain('hello')
    expect(switchAccount.restartSessionProcess.mock.invocationCallOrder[0]).toBeLessThan(
      sessionsWrite.mock.invocationCallOrder[0]
    )
  })

  it('reaches a tab before and after a window reload, and never without a tab identity', async () => {
    // A reloaded window: no live messaging link, no spawnedBy or openedBy on
    // the child; only main's lineage knows who opened it. Since PRDCT-4236
    // the lineage no longer decides the reach: the send goes through either way.
    useSessionStore.setState({ sessions: [agent('l-lead'), agent('l-child')] })
    const before = await dispatch('sendToSession', {
      callerSessionId: 'l-lead',
      sessionId: 'l-child',
      message: 'status?'
    })
    expect(before).toMatchObject({ ok: true, result: { delivered: true, sessionId: 'l-child' } })
    const anonymous = await dispatch('sendToSession', { sessionId: 'l-child', message: 'status?' })
    expect(anonymous).toMatchObject({
      ok: false,
      error:
        'clave_send_to_session must be called from inside a Clave agent tab — this request has no tab identity.'
    })
    const after = await dispatch(
      'sendToSession',
      { callerSessionId: 'l-lead', sessionId: 'l-child', message: 'status?' },
      { 'l-child': 'l-lead' }
    )
    expect(after).toMatchObject({ ok: true, result: { delivered: true, sessionId: 'l-child' } })
  })

  it('reaches a tab through the opener on its record when the lineage has none', async () => {
    useSessionStore.setState({
      sessions: [agent('o-lead'), agent('o-child', { openedBy: 'o-lead' })]
    })
    const answer = await dispatch('sendToSession', {
      callerSessionId: 'o-lead',
      sessionId: 'o-child',
      message: 'status?'
    })
    expect(answer).toMatchObject({ ok: true, result: { delivered: true } })
  })

  it("starts a server tab's serving terminal on that server, not on the Mac", async () => {
    const remote = resourceKey('session', 'srv', 'viewed')
    const fleetStart = vi.fn(async (_server: string, cwd: string) => ({
      id: resourceKey('session', 'srv', 'serving'),
      cwd,
      folderName: 'repo',
      alive: true
    }))
    Object.assign(globals.window.electronAPI, { fleetStart, startSession: vi.fn() })
    useSessionStore.setState({ sessions: [agent(remote)] })
    const answer = await dispatch('setSessionView', {
      callerSessionId: remote,
      sessionId: remote,
      url: 'http://localhost:4000',
      command: 'npm run dev'
    })
    expect(answer.ok).toBe(true)
    expect(fleetStart).toHaveBeenCalledTimes(1)
    expect(fleetStart).toHaveBeenCalledWith(
      'srv',
      '/repo',
      expect.objectContaining({
        initialCommand: 'npm run dev',
        link: { kind: 'session-view', ownerId: remote }
      })
    )
    expect(spawnSession).not.toHaveBeenCalled()
  })
})

/* Round 1 of the lane's verifier: a stopped terminal asked to resume and
   deliver must be refused before any restart (C1), and the paired-workspace
   placement must reach the fleet open from the dispatcher (C6). */
describe('round 1: the window road refuses before resuming, and places by the pairing', () => {
  const dispatchOnce = async (
    command: string,
    payload: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    let receive: (msg: { requestId: string; command: string; payload: unknown }) => void = () => {}
    const response = new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
      globals.window.electronAPI.onMcpCommand = (handler: typeof receive) => {
        receive = handler
        return () => {}
      }
      globals.window.electronAPI.mcpRespond = resolve
    })
    globals.window.electronAPI.lineageParents = vi.fn(async () => ({}))
    const unsubscribe = initMcpDispatcher()
    await new Promise((r) => setTimeout(r, 0))
    receive({ requestId: command, command, payload })
    try {
      return await response
    } finally {
      unsubscribe()
    }
  }
  beforeEach(() => {
    switchAccount.restartSessionProcess.mockReset()
    switchAccount.restartSessionProcess.mockImplementation(async () => ({
      ok: true,
      resumed: true
    }))
    Object.assign(globals.window.electronAPI, {
      sessionsWrite: vi.fn(async () => undefined),
      sessionsList: vi.fn(async () => []),
      captureExchangeMessage: vi.fn(),
      fleetSnapshot: vi.fn(async () => undefined)
    })
  })

  it('refuses a stopped plain terminal with resume: true, restarting nothing (C1)', async () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 'c1-lead',
          name: 'Lead',
          cwd: '/r',
          sessionType: 'local',
          alive: true,
          claudeMode: true
        },
        {
          id: 'c1-term',
          name: 'Dev server',
          cwd: '/r',
          sessionType: 'local',
          alive: false,
          claudeMode: false,
          spawnedBy: 'c1-lead'
        }
      ] as never
    })
    const answer = await dispatchOnce('sendToSession', {
      callerSessionId: 'c1-lead',
      sessionId: 'c1-term',
      message: 'npm run dev',
      resume: true
    })
    expect(answer.ok).toBe(false)
    expect(answer.error).toContain('Refusing to send to a plain terminal')
    expect(switchAccount.restartSessionProcess).not.toHaveBeenCalled()
  })

  it('refuses a stopped claude agents menu with resume: true, restarting nothing (round 2, R05)', async () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 'r5-lead',
          name: 'Lead',
          cwd: '/r',
          sessionType: 'local',
          alive: true,
          claudeMode: true
        },
        {
          id: 'r5-menu',
          name: 'Agents',
          cwd: '/r',
          sessionType: 'local',
          alive: false,
          claudeMode: true,
          claudeAgentsMode: true,
          spawnedBy: 'r5-lead'
        }
      ] as never
    })
    const answer = await dispatchOnce('sendToSession', {
      callerSessionId: 'r5-lead',
      sessionId: 'r5-menu',
      message: 'pick one',
      resume: true
    })
    expect(answer.ok).toBe(false)
    expect(answer.error).toContain('Refusing to send to a `claude agents` tab')
    expect(switchAccount.restartSessionProcess).not.toHaveBeenCalled()
  })

  it('reads a chat, on this Mac or on a server, as lines of its history (PRDCT-4199)', async () => {
    const remote = resourceKey('session', 'srv', 'chat')
    useSessionStore.setState({
      sessions: [
        {
          id: 'rd-lead',
          name: 'Lead',
          cwd: '/r',
          sessionType: 'local',
          alive: true,
          claudeMode: true
        },
        {
          id: remote,
          name: 'Server chat',
          cwd: '/srv/r',
          sessionType: 'local',
          alive: true,
          claudeMode: true,
          agentState: 'idle',
          spawnedBy: 'rd-lead'
        }
      ] as never
    })
    const sessionsHistory = vi.fn(async () => ({
      items: [
        { event: { type: 'user_message', text: 'hello server' }, at: 1 },
        { event: { type: 'assistant_text', delta: 'stub heard: hello server', final: true }, at: 2 }
      ],
      before: null
    }))
    Object.assign(globals.window.electronAPI, {
      sessionsList: vi.fn(async () => [{ id: remote, transport: 'events' }]),
      sessionsHistory,
      fleetScreen: vi.fn(async () => {
        throw new Error('no terminal screen')
      })
    })
    const answer = await dispatchOnce('readSession', {
      callerSessionId: 'rd-lead',
      sessionId: remote,
      lines: 50
    })
    expect(answer.ok).toBe(true)
    expect(answer.result).toMatchObject({
      sessionId: remote,
      name: 'Server chat',
      mode: 'claude',
      alive: true,
      agentState: 'idle',
      lines: 2,
      text: 'You: hello server\nAgent: stub heard: hello server'
    })
    expect((answer.result as { history: unknown[] }).history).toHaveLength(2)
    expect(sessionsHistory).toHaveBeenCalledWith(remote, undefined, 50)
  })

  it('names the reachable tab when a Mac tab and a server tab share a name (round 3, C4)', async () => {
    const remote = resourceKey('session', 'srv', 'lane-a')
    useSessionStore.setState({
      sessions: [
        {
          id: 'c4-lead',
          name: 'Lead',
          cwd: '/r',
          sessionType: 'local',
          alive: true,
          claudeMode: true
        },
        // The Mac's own "Lane A", unrelated to the caller, listed first.
        {
          id: 'c4-local',
          name: 'Lane A',
          cwd: '/r',
          sessionType: 'local',
          alive: true,
          claudeMode: true
        },
        {
          id: remote,
          name: 'Lane A',
          cwd: '/srv/r',
          sessionType: 'local',
          alive: true,
          claudeMode: true,
          spawnedBy: 'c4-lead'
        }
      ] as never
    })
    Object.assign(globals.window.electronAPI, {
      sessionsList: vi.fn(async () => [{ id: remote, transport: 'events' }]),
      sessionsWrite: vi.fn(async () => undefined)
    })
    const answer = await dispatchOnce('sendToSession', {
      callerSessionId: 'c4-lead',
      sessionId: 'Lane A',
      message: 'hello'
    })
    expect(answer.ok).toBe(true)
    expect(answer.result).toMatchObject({ sessionId: remote, delivered: true })
  })

  it('opens a server tab in the server workspace paired with the caller’s (C6)', async () => {
    const paired = resourceKey('workspace', 'srv', 'ws-raw')
    useWorkspaceStore.setState({
      activeWorkspaceId: 'ws-local',
      workspaces: [
        { id: 'ws-local', name: 'Local', rootDir: '/local', profileFile: null, createdAt: 1 }
      ],
      serverWorkspaces: {
        srv: [{ id: paired, name: 'Studio', rootDir: '/srv/repo', profileFile: null, createdAt: 1 }]
      }
    })
    useSessionStore.setState({
      sessions: [
        {
          id: 'c6-lead',
          cwd: '/local/x',
          sessionType: 'local',
          alive: true,
          workspaceId: 'ws-local'
        }
      ] as never
    })
    useFleetStore.setState({
      connections: [{ id: 'srv', name: 'Studio Mac', url: 'http://srv', enabled: true }] as never,
      statuses: { srv: { serverId: 'srv', state: 'connected' } } as never
    })
    usePairingStore.setState({
      servers: { srv: { combine: true, pairs: { 'ws-raw': 'ws-local' }, declined: [] } }
    } as never)
    const fleetStart = vi.fn(async (serverId: string, cwd: string) => ({
      id: resourceKey('session', serverId, 'new'),
      cwd,
      folderName: 'elsewhere',
      alive: true,
      claudeSessionId: null,
      piSessionId: null
    }))
    Object.assign(globals.window.electronAPI, {
      fleetStart,
      resizeSession: vi.fn(),
      setSessionDisplayName: vi.fn(async () => undefined)
    })
    try {
      // The directory is under no root of the server: only the pairing places it.
      const result = (await openSessionProgrammatically({
        cwd: '/srv/elsewhere',
        server: 'srv',
        mode: 'terminal',
        command: 'ls',
        callerSessionId: 'c6-lead'
      })) as { workspaceId: string | null }
      expect(fleetStart).toHaveBeenCalledWith(
        'srv',
        '/srv/elsewhere',
        expect.objectContaining({ workspaceId: paired })
      )
      expect(result.workspaceId).toBe(paired)
    } finally {
      usePairingStore.setState({ servers: {} } as never)
      useFleetStore.setState({ connections: [], statuses: {} } as never)
    }
  })
})
