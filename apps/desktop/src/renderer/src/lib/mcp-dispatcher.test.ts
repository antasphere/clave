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
import type { LaunchProfile, LaunchProfilePreferences } from '../../../../../../packages/shared/src/agent-launch'

/* The window road of clave_open_session: the renderer's own executor, the one
   a Mac with a saved server connection runs every open through (and the only
   one FileTree reaches). It is reached by no end-to-end spec (the per-tab
   endpoint serves the open in main unless a fleet server is saved), so the
   chat it picks is pinned here: the chat the launcher would open, the
   workspace's or global default's chat form, read from the Mac's own store. */

vi.mock('./switch-account', () => ({
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

  it('refuses to assign a tab the caller is not related to, before any change', async () => {
    const answer = await dispatch('setWork', {
      callerSessionId: 'caller',
      sessionId: 'stranger',
      role: 'verifier'
    })
    expect(answer.ok).toBe(false)
    expect(answer.error).toMatch(/not related to yours/)
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
