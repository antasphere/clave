import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import type { SessionGroup, Session, PinnedGroup } from './session-types'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  resolveAccount: vi.fn(),
  state: {
    groups: [] as SessionGroup[],
    sessions: [] as Session[],
    addSession: vi.fn(),
    createGroup: vi.fn(),
    renameSession: vi.fn(),
    setFocusedSession: vi.fn(),
    selectSession: vi.fn()
  }
}))
vi.mock('../lib/launch-session', () => ({ launchSession: mocks.launch }))
vi.mock('../lib/switch-account', () => ({ resolveAccountRef: mocks.resolveAccount }))
vi.mock('./claude-profile-store', () => ({ getClaudeProfile: vi.fn() }))
vi.mock('./codex-account-store', () => ({ getCodexAccount: vi.fn() }))
vi.mock('./session-store', () => ({
  useSessionStore: {
    getState: () => mocks.state,
    setState: (updater: (state: typeof mocks.state) => Partial<typeof mocks.state>) =>
      Object.assign(mocks.state, updater(mocks.state)),
    subscribe: () => () => {}
  }
}))
let pinned: typeof import('./pinned-store')
let workspace: typeof import('./workspace-store')
const workspaceId = resourceKey('workspace', 'vps', 'ws')
const file = (path: string): string => resourceKey('file', 'vps', path)
const pin = (): PinnedGroup => ({
  id: 'pin',
  name: 'Server group',
  cwd: '/repo/project',
  color: null,
  sessions: [
    {
      name: 'Agent',
      cwd: '/repo/project',
      claudeMode: false,
      antigravityMode: false,
      codexMode: true,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: true,
      account: 'Mac-only',
      rootSession: true,
      prompt: 'Read @root_path'
    },
    {
      name: 'Terminal',
      cwd: '/repo/project',
      claudeMode: false,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false
    }
  ],
  terminals: [],
  createdAt: 1,
  activeGroupId: null,
  visible: false,
  workspaceId,
  workspaceRoot: '/repo',
  filePath: file('/repo/default.clave'),
  rootDir: file('/repo')
})
beforeAll(async () => {
  vi.stubGlobal('window', { electronAPI: {} })
  vi.stubGlobal('localStorage', { getItem: () => null })
  pinned = await import('./pinned-store')
  workspace = await import('./workspace-store')
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  pinned.usePinnedStore.setState({ pinnedGroups: [] })
  mocks.state.groups = []
  mocks.state.sessions = []
  mocks.state.createGroup.mockImplementation((ids, name, workspaceId) => {
    mocks.state.groups.push({
      id: resourceKey('group', 'vps', 'group'),
      name,
      sessionIds: ids,
      workspaceId,
      terminals: [],
      cwd: '/repo',
      collapsed: false
    } as SessionGroup)
  })
  mocks.launch.mockImplementation(async () =>
    resourceKey('session', 'vps', String(mocks.launch.mock.calls.length))
  )
  workspace.useWorkspaceStore.setState({
    activeWorkspaceId: workspaceId,
    serverWorkspaces: {
      vps: [{ id: workspaceId, name: 'Server', rootDir: '/repo', profileFile: null, createdAt: 1 }]
    }
  })
  window.electronAPI = {
    spawnSession: vi.fn(),
    discoverClaveFiles: vi.fn(async () => [
      { name: 'other', path: file('/repo/other.clave'), rootDir: file('/repo') },
      { name: 'default', path: file('/repo/default.clave'), rootDir: file('/repo') }
    ]),
    claveFileExists: vi.fn(async () => true),
    readClaveFile: vi.fn(async () => ({
      type: 'single',
      name: 'Fresh',
      cwd: '/repo',
      color: null,
      sessions: [],
      terminals: []
    })),
    watchClaveFile: vi.fn(async () => {}),
    unwatchClaveFile: vi.fn(async () => {}),
    readAutoDiscoverConfig: vi.fn(async () => null)
  } as unknown as Window['electronAPI']
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
it('launches each server session through launchSession with no account fields or local addSession', async () => {
  const p = pin()
  pinned.usePinnedStore.getState().addPinnedGroup(p)
  await pinned.togglePinnedGroup(p.id)
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(mocks.launch.mock.calls[0][0]).toEqual({
    serverId: 'vps',
    cwd: { kind: 'path', path: '/repo' },
    setup: { kind: 'codex', dangerousMode: true },
    initialPrompt: 'Read /repo',
    workspaceId,
    throwOnError: true
  })
  expect(mocks.launch.mock.calls[1][0]).toEqual({
    serverId: 'vps',
    cwd: { kind: 'path', path: '/repo/project' },
    setup: null,
    initialPrompt: undefined,
    workspaceId,
    throwOnError: true
  })
  expect(mocks.resolveAccount).not.toHaveBeenCalled()
  expect(window.electronAPI.spawnSession).not.toHaveBeenCalled()
  expect(mocks.state.addSession).not.toHaveBeenCalled()
  expect(mocks.state.createGroup).toHaveBeenCalledWith(
    [resourceKey('session', 'vps', '1'), resourceKey('session', 'vps', '2')],
    p.name,
    workspaceId
  )
  expect(pinned.usePinnedStore.getState().pinnedGroups[0].activeGroupId).toBe(
    resourceKey('group', 'vps', 'group')
  )
})
it('does not pin a live server group', () => {
  const groupId = resourceKey('group', 'vps', 'group')
  mocks.state.sessions = pin().sessions.map(
    (s, index): Session => ({
      ...s,
      id: resourceKey('session', 'vps', String(index)),
      folderName: 'project',
      alive: true,
      activityStatus: 'idle',
      promptWaiting: null,
      claudeSessionId: null,
      sessionType: 'local',
      detectedUrl: null,
      serverStatus: null,
      serverCommand: null,
      hasUnseenActivity: false,
      userRenamed: false,
      planFilePath: null
    })
  )
  mocks.state.groups = [
    {
      id: groupId,
      name: 'Live server group',
      sessionIds: mocks.state.sessions.map((s) => s.id),
      collapsed: false,
      cwd: '/repo/project',
      terminals: [],
      workspaceId
    }
  ]
  pinned.pinGroupFromCurrent(groupId)
  expect(pinned.usePinnedStore.getState().pinnedGroups).toEqual([])
})
it('discovers default on the server, stamps keyed roots and prunes vanished files', async () => {
  const stale = { ...pin(), id: 'stale', filePath: file('/repo/gone.clave') }
  pinned.usePinnedStore.setState({ pinnedGroups: [stale] })
  const ws = workspace.useWorkspaceStore.getState().serverWorkspaces.vps[0]
  await pinned.refreshWorkspacePins(ws)
  expect(window.electronAPI.discoverClaveFiles).toHaveBeenCalledWith(file('/repo'))
  expect(window.electronAPI.readClaveFile).toHaveBeenCalledWith(
    file('/repo/default.clave'),
    file('/repo')
  )
  expect(pinned.usePinnedStore.getState().pinnedGroups).toMatchObject([
    {
      name: 'Fresh',
      filePath: file('/repo/default.clave'),
      rootDir: file('/repo'),
      workspaceRoot: '/repo',
      workspaceId,
      cwd: '/repo'
    }
  ])
  expect(window.electronAPI.unwatchClaveFile).toHaveBeenCalledWith(stale.filePath)
})
it('uses the explicit server profile and prunes when it disappears', async () => {
  const ws = {
    ...workspace.useWorkspaceStore.getState().serverWorkspaces.vps[0],
    profileFile: '/repo/chosen.clave'
  }
  await pinned.refreshWorkspacePins(ws)
  expect(window.electronAPI.discoverClaveFiles).not.toHaveBeenCalled()
  expect(window.electronAPI.readClaveFile).toHaveBeenCalledWith(
    file('/repo/chosen.clave'),
    file('/repo')
  )
  vi.mocked(window.electronAPI.claveFileExists).mockResolvedValue(false)
  await pinned.refreshWorkspacePins(ws)
  expect(pinned.usePinnedStore.getState().pinnedGroups).toEqual([])
})
it('continues after a failed server launch and groups only successful sessions', async () => {
  mocks.launch.mockRejectedValueOnce(new Error('offline'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  pinned.usePinnedStore.getState().addPinnedGroup(pin())
  await pinned.togglePinnedGroup('pin')
  expect(mocks.state.createGroup).toHaveBeenCalledWith(
    [resourceKey('session', 'vps', '2')],
    'Server group',
    workspaceId
  )
  log.mockRestore()
})
