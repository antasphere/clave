import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import type { SessionGroup, Session, PinnedGroup } from './session-types'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  resolveAccount: vi.fn(),
  launchModel: vi.fn<(provider: string) => Promise<string | undefined>>(async () => undefined),
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
vi.mock('../lib/launch-model', () => ({ rememberedLaunchModel: mocks.launchModel }))
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

it("judges a pinned session's account for the model its chat will run (PRDCT-4302), the server pin never", async () => {
  const localWorkspace = 'local-ws'
  workspace.useWorkspaceStore.setState({
    activeWorkspaceId: localWorkspace,
    workspaces: [
      { id: localWorkspace, name: 'Local', rootDir: '/repo', profileFile: null, createdAt: 1 }
    ],
    serverWorkspaces: {}
  })
  mocks.launchModel.mockImplementation(async (provider: string) =>
    provider === 'claude' ? 'claude-opus-5-5' : undefined
  )
  mocks.resolveAccount.mockReturnValue({ id: 'work', label: 'Work' })
  ;(window.electronAPI.spawnSession as ReturnType<typeof vi.fn>).mockImplementation(
    async (cwd: string) => ({ id: `s-${Math.random()}`, cwd, folderName: 'project', alive: true })
  )
  const p: PinnedGroup = {
    ...pin(),
    workspaceId: localWorkspace,
    filePath: '/repo/default.clave',
    rootDir: '/repo',
    sessions: [
      { ...pin().sessions[0], codexMode: false, claudeMode: true, account: 'Work' },
      { ...pin().sessions[0], account: 'Codex work' }
    ]
  }
  pinned.usePinnedStore.setState({ pinnedGroups: [p] })
  await pinned.togglePinnedGroup('pin')
  expect(mocks.launchModel).toHaveBeenCalledWith('claude', undefined, localWorkspace)
  expect(mocks.launchModel).toHaveBeenCalledWith('codex', undefined, localWorkspace)
  expect(mocks.resolveAccount).toHaveBeenCalledWith('claude', 'Work', 'claude-opus-5-5')
  expect(mocks.resolveAccount).toHaveBeenCalledWith('codex', 'Codex work', undefined)
  expect(mocks.launch).not.toHaveBeenCalled()
})

// ── Pinning a live group (PRDCT-4830) ──

const tab = (id: string, fields: Partial<Session>): Session => ({
  id,
  cwd: '/repo/project',
  folderName: 'project',
  name: id,
  alive: true,
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
  ...fields
})

const liveGroup = (fields: Partial<SessionGroup> = {}): SessionGroup => ({
  id: 'group-live',
  name: 'Clave',
  sessionIds: ['plain', 'explore', 'fix', 'term-run'],
  collapsed: false,
  cwd: '/repo/clave',
  prompt: 'You are on Clave. Read @root_path. Wait for my instructions.',
  color: 'blue',
  terminals: [
    {
      id: 't1',
      command: 'npm run dev',
      commandMode: 'auto',
      color: 'green',
      icon: 'bolt',
      cwd: '/repo/clave/app',
      autoLaunchLocalhost: true,
      serverUrl: 'http://127.0.0.1:5173',
      groupView: true,
      sessionId: 'term-run'
    }
  ],
  workspaceId: 'local-ws',
  ...fields
})

const liveTabs = (): Session[] => [
  tab('plain', { name: '.antasphere' }),
  tab('explore', {
    name: 'explore group placement',
    codexMode: true,
    dangerousMode: true,
    codexAccountId: 'work',
    codexAccountLabel: 'Codex work'
  }),
  tab('fix', { name: 'fix clive group terminals', claudeMode: true }),
  tab('term-run', { name: 'npm run dev' })
]

const useLocalWorkspace = (): void => {
  workspace.useWorkspaceStore.setState({
    activeWorkspaceId: 'local-ws',
    workspaces: [
      { id: 'local-ws', name: 'Local', rootDir: '/repo', profileFile: null, createdAt: 1 }
    ],
    serverWorkspaces: {}
  })
}

it('pins a live group as the group and one chat tab, never a photograph of its tabs', () => {
  useLocalWorkspace()
  mocks.state.groups = [liveGroup()]
  mocks.state.sessions = liveTabs()
  pinned.pinGroupFromCurrent('group-live')
  const [pg] = pinned.usePinnedStore.getState().pinnedGroups
  expect(pinned.usePinnedStore.getState().pinnedGroups).toHaveLength(1)
  expect(pg).toMatchObject({
    name: 'Clave',
    cwd: '/repo/clave',
    color: 'blue',
    prompt: 'You are on Clave. Read @root_path. Wait for my instructions.',
    workspaceRoot: '/repo',
    // The pin belongs to the workspace its group lives in.
    workspaceId: 'local-ws',
    activeGroupId: 'group-live'
  })
  // ONE session: named after the group, on the first agent tab's harness,
  // permission mode and account label, starting on the group's prompt.
  expect(pg.sessions).toEqual([
    {
      name: 'Clave',
      cwd: '/repo/clave',
      claudeMode: false,
      antigravityMode: false,
      codexMode: true,
      piMode: false,
      opencodeMode: false,
      claudeAgentsMode: false,
      dangerousMode: true,
      prompt: 'You are on Clave. Read @root_path. Wait for my instructions.',
      account: 'Codex work'
    }
  ])
  // The group terminals keep every authored field.
  expect(pg.terminals).toEqual([
    {
      command: 'npm run dev',
      commandMode: 'auto',
      color: 'green',
      icon: 'bolt',
      cwd: '/repo/clave/app',
      autoLaunchLocalhost: true,
      serverUrl: 'http://127.0.0.1:5173',
      groupView: true
    }
  ])
})

it("keeps a root-anchored group's anchor on the pin's one tab", () => {
  useLocalWorkspace()
  mocks.state.groups = [liveGroup({ rootSession: true })]
  mocks.state.sessions = liveTabs()
  pinned.pinGroupFromCurrent('group-live')
  const [pg] = pinned.usePinnedStore.getState().pinnedGroups
  expect(pg.sessions).toHaveLength(1)
  expect(pg.sessions[0]).toMatchObject({ cwd: '/repo/clave', rootSession: true })
  expect(pg.workspaceRoot).toBe('/repo')
})

it('gives a group with no agent tab a Claude tab', () => {
  useLocalWorkspace()
  mocks.state.groups = [liveGroup({ prompt: null, sessionIds: ['plain'], terminals: [] })]
  mocks.state.sessions = liveTabs()
  pinned.pinGroupFromCurrent('group-live')
  const [pg] = pinned.usePinnedStore.getState().pinnedGroups
  expect(pg.sessions).toEqual([
    {
      name: 'Clave',
      cwd: '/repo/clave',
      claudeMode: true,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      opencodeMode: false,
      claudeAgentsMode: false,
      dangerousMode: false
    }
  ])
})

// ── A new pin belongs to its workspace ──

it('stamps a new pin with the workspace of this Mac its group lives in, the active one for an unstamped group', () => {
  useLocalWorkspace()
  workspace.useWorkspaceStore.setState({
    workspaces: [
      { id: 'local-ws', name: 'Local', rootDir: '/repo', profileFile: null, createdAt: 1 },
      { id: 'other-ws', name: 'Other', rootDir: '/other', profileFile: null, createdAt: 2 }
    ]
  })
  mocks.state.sessions = liveTabs()
  // The group's own workspace wins over the one the window shows.
  mocks.state.groups = [liveGroup({ workspaceId: 'other-ws' })]
  expect(pinned.pinGroupFromCurrent('group-live')).toMatchObject({ created: true })
  expect(pinned.usePinnedStore.getState().pinnedGroups[0]).toMatchObject({
    workspaceId: 'other-ws',
    workspaceRoot: '/other'
  })
  // A group with no workspace of its own takes the active one.
  pinned.usePinnedStore.setState({ pinnedGroups: [] })
  mocks.state.groups = [liveGroup({ workspaceId: undefined })]
  pinned.pinGroupFromCurrent('group-live')
  expect(pinned.usePinnedStore.getState().pinnedGroups[0]).toMatchObject({
    workspaceId: 'local-ws',
    workspaceRoot: '/repo'
  })
})

it("leaves a pin unstamped on a server's workspace, where a saved pin would not survive a restart, and in no workspace at all", () => {
  // beforeEach leaves the window on the server's workspace.
  mocks.state.sessions = liveTabs()
  mocks.state.groups = [liveGroup({ workspaceId, rootSession: true })]
  pinned.pinGroupFromCurrent('group-live')
  const [onServer] = pinned.usePinnedStore.getState().pinnedGroups
  expect(onServer.workspaceId).toBeNull()
  // No root of this Mac to open a root-anchored tab in: the anchor is kept for
  // the group's `+`, and the tab opens in the group's folder.
  expect(onServer.workspaceRoot).toBeNull()
  expect(onServer.sessions[0]).toMatchObject({ cwd: '/repo/clave', rootSession: true })

  pinned.usePinnedStore.setState({ pinnedGroups: [] })
  workspace.useWorkspaceStore.setState({ activeWorkspaceId: null, serverWorkspaces: {} })
  mocks.state.groups = [liveGroup({ workspaceId: undefined })]
  pinned.pinGroupFromCurrent('group-live')
  expect(pinned.usePinnedStore.getState().pinnedGroups[0].workspaceId).toBeNull()
})

it('does not stamp a pin with a workspace this Mac no longer has: the boot would drop it', () => {
  useLocalWorkspace()
  mocks.state.sessions = liveTabs()
  mocks.state.groups = [liveGroup({ workspaceId: 'gone-ws' })]
  pinned.pinGroupFromCurrent('group-live')
  expect(pinned.usePinnedStore.getState().pinnedGroups[0].workspaceId).toBeNull()
})

// ── A group remembers the pin it came from ──

const savedPin = (fields: Partial<PinnedGroup> = {}): PinnedGroup => ({
  id: 'saved',
  name: 'Clave',
  cwd: '/repo/clave',
  color: null,
  sessions: [],
  terminals: [],
  createdAt: 1,
  activeGroupId: null,
  visible: false,
  workspaceId: null,
  ...fields
})
const filePin = (fields: Partial<PinnedGroup> = {}): PinnedGroup =>
  savedPin({
    id: 'file',
    filePath: '/repo/clave/.clave/workspaces/default.clave',
    workspaceId: 'local-ws',
    ...fields
  })

it('stamps the group with the pin made from it, so a restart that drops the link makes no second pin', () => {
  useLocalWorkspace()
  mocks.state.sessions = liveTabs()
  mocks.state.groups = [liveGroup()]
  const made = pinned.pinGroupFromCurrent('group-live')
  expect(made).toMatchObject({ created: true })
  expect(mocks.state.groups[0].templateId).toBe(made!.pinnedId)
  // The restart: the pin comes back unlinked, the group renamed and moved since.
  pinned.usePinnedStore.setState({
    pinnedGroups: pinned.usePinnedStore
      .getState()
      .pinnedGroups.map((p) => ({ ...p, activeGroupId: null, visible: false }))
  })
  mocks.state.groups = [{ ...mocks.state.groups[0], name: 'Renamed', cwd: '/repo/moved' }]
  expect(pinned.pinGroupFromCurrent('group-live')).toEqual({
    pinnedId: made!.pinnedId,
    created: false
  })
  expect(pinned.usePinnedStore.getState().pinnedGroups).toHaveLength(1)
})

it("opens the pin's tab at the workspace root for a group with no folder, where its + opens", () => {
  useLocalWorkspace()
  mocks.state.sessions = liveTabs()
  // A group an agent made: it has no folder of its own.
  mocks.state.groups = [liveGroup({ cwd: null, prompt: null })]
  pinned.pinGroupFromCurrent('group-live')
  const [pg] = pinned.usePinnedStore.getState().pinnedGroups
  expect(pg).toMatchObject({ cwd: '/repo', workspaceRoot: '/repo' })
  expect(pg.sessions).toHaveLength(1)
  expect(pg.sessions[0]).toMatchObject({ name: 'Clave', cwd: '/repo', rootSession: true })
})

it('stamps the group a pin launches with that pin, linked or not', async () => {
  // Linked: the toggle.
  const p = pin()
  pinned.usePinnedStore.getState().addPinnedGroup(p)
  await pinned.togglePinnedGroup(p.id)
  expect(mocks.state.groups[0].templateId).toBe('pin')
  // Unlinked: the group picker's launch, which is where the trace was lost.
  mocks.state.groups = []
  pinned.usePinnedStore.setState({ pinnedGroups: [{ ...pin(), id: 'picked' }] })
  await pinned.spawnTemplate('picked')
  expect(mocks.state.groups[0].templateId).toBe('picked')
  expect(pinned.usePinnedStore.getState().pinnedGroups[0].activeGroupId).toBeNull()
})

it('pins no copy of a group launched from a pin: the answer names the pin it came from', () => {
  useLocalWorkspace()
  mocks.state.sessions = liveTabs()
  // Renamed and moved since its launch, so only the stamp can tell.
  mocks.state.groups = [
    liveGroup({ name: 'Clave work', cwd: '/repo/elsewhere', templateId: 'file' })
  ]
  pinned.usePinnedStore.setState({ pinnedGroups: [filePin()] })
  expect(pinned.pinGroupFromCurrent('group-live')).toEqual({ pinnedId: 'file', created: false })
  expect(pinned.usePinnedStore.getState().pinnedGroups).toEqual([filePin()])
  expect(pinned.findPinOfGroup('group-live')?.id).toBe('file')
})

it('pins no copy of a group that has a pin of its name and folder, stamp or not', () => {
  useLocalWorkspace()
  mocks.state.sessions = liveTabs()
  // Launched before the stamp existed: nothing but the name and the folder.
  mocks.state.groups = [liveGroup()]
  pinned.usePinnedStore.setState({ pinnedGroups: [filePin()] })
  expect(pinned.pinGroupFromCurrent('group-live')).toEqual({ pinnedId: 'file', created: false })
  expect(pinned.usePinnedStore.getState().pinnedGroups).toHaveLength(1)
})

it('answers the linked pin for a group already pinned', () => {
  useLocalWorkspace()
  mocks.state.sessions = liveTabs()
  mocks.state.groups = [liveGroup({ name: 'Other name' })]
  pinned.usePinnedStore.setState({
    pinnedGroups: [savedPin({ id: 'linked', name: 'Was pinned', activeGroupId: 'group-live' })]
  })
  expect(pinned.pinGroupFromCurrent('group-live')).toEqual({ pinnedId: 'linked', created: false })
  expect(pinned.usePinnedStore.getState().pinnedGroups).toHaveLength(1)
})

it('recognises the pin a group came from only among the pins the picker lists', () => {
  const group = { name: 'Clave', cwd: '/repo/clave', templateId: 'file' }
  // The stamp wins over a pin that merely shares the name and the folder.
  const twin = savedPin({ id: 'twin', workspaceId: 'local-ws' })
  expect(pinned.findTemplateOfGroup(group, [twin, filePin()], 'local-ws')?.id).toBe('file')
  // A stamp naming a pin that is gone falls back to the name and the folder.
  expect(pinned.findTemplateOfGroup({ ...group, templateId: 'gone' }, [twin], 'local-ws')?.id).toBe(
    'twin'
  )
  // An unstamped pin shows in every workspace, so it counts in each.
  expect(pinned.findTemplateOfGroup(group, [savedPin()], 'any-ws')?.id).toBe('saved')
  // Another workspace's pin, and a toolbar's, have no card here: no pin.
  expect(
    pinned.findTemplateOfGroup(group, [filePin({ workspaceId: 'other-ws' })], 'local-ws')
  ).toBe(null)
  expect(pinned.findTemplateOfGroup(group, [filePin({ toolbar: true })], 'local-ws')).toBe(null)
  // The same name in another folder, or another name in the same folder, is another group.
  const unstamped = { name: 'Clave', cwd: '/repo/clave' }
  expect(pinned.findTemplateOfGroup(unstamped, [filePin({ cwd: '/repo/other' })], 'local-ws')).toBe(
    null
  )
  expect(pinned.findTemplateOfGroup(unstamped, [filePin({ name: 'Exos' })], 'local-ws')).toBe(null)
  expect(pinned.pinInPicker(filePin(), 'local-ws')).toBe(true)
  expect(pinned.pinInPicker(filePin({ toolbar: true }), 'local-ws')).toBe(false)
  expect(pinned.pinInPicker(filePin(), 'other-ws')).toBe(false)
})

// ── The saved copies of a file pin, cleared once ──

const memoryStorage = (): { store: Map<string, string>; restore: () => void } => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  })
  return { store, restore: () => vi.stubGlobal('localStorage', { getItem: () => null }) }
}

it('names as copies the saved pins with the name and the folder of a file pin shown in the same workspace', () => {
  const clave = filePin()
  const pins = [
    clave,
    // The two copies of the real case: unstamped, so shown in every workspace.
    savedPin({ id: 'copy-august' }),
    savedPin({ id: 'copy-november' }),
    // A saved pin with no file pin of its name and folder is someone's own.
    savedPin({ id: 'own', name: 'ConnexAfrica', cwd: '/repo/connexafrica' }),
    // Same name, another folder; same folder, another name: not copies.
    savedPin({ id: 'other-folder', cwd: '/repo/clave-website' }),
    savedPin({ id: 'other-name', name: 'Clave site' }),
    // A copy stamped with another workspace is not shown beside this file pin.
    savedPin({ id: 'elsewhere', workspaceId: 'other-ws' }),
    // A copy stamped with this workspace is.
    savedPin({ id: 'copy-here', workspaceId: 'local-ws' }),
    // A file pin is never a copy, whatever it shares.
    filePin({ id: 'second-file', filePath: '/repo/clave/other.clave' })
  ]
  expect(pinned.filePinTwins(pins, 'local-ws').map((p) => p.id)).toEqual([
    'copy-august',
    'copy-november',
    'copy-here'
  ])
  // In a workspace that does not show the file pin there is nothing to double.
  expect(pinned.filePinTwins(pins, 'other-ws')).toEqual([])
  // With no file pin at all, no saved pin is a copy.
  expect(
    pinned.filePinTwins(
      pins.filter((p) => !p.filePath),
      'local-ws'
    )
  ).toEqual([])
})

it("clears the saved copies of a workspace's file pins once its files are read, once, and keeps the rest", async () => {
  const storage = memoryStorage()
  try {
    // The server workspace's file answers one group, "Fresh" in /repo (beforeEach).
    const ws = workspace.useWorkspaceStore.getState().serverWorkspaces.vps[0]
    pinned.usePinnedStore.setState({
      pinnedGroups: [
        savedPin({ id: 'copy-1', name: 'Fresh', cwd: '/repo' }),
        savedPin({ id: 'copy-2', name: 'Fresh', cwd: '/repo' }),
        savedPin({ id: 'own', name: 'ConnexAfrica', cwd: '/repo/connexafrica' })
      ]
    })
    await pinned.refreshWorkspacePins(ws)
    expect(pinned.usePinnedStore.getState().pinnedGroups.map((p) => p.name)).toEqual([
      'ConnexAfrica',
      'Fresh'
    ])
    expect(pinned.usePinnedStore.getState().pinnedGroups[0].id).toBe('own')
    expect(pinned.usePinnedStore.getState().pinnedGroups[1].filePath).toBe(
      file('/repo/default.clave')
    )
    // Done for this workspace, and what was removed is kept to be put back by hand.
    expect(JSON.parse(storage.store.get('clave-pin-twins-cleared')!)).toEqual([workspaceId])
    expect(
      JSON.parse(storage.store.get('clave-pin-twins-removed')!).map((p: PinnedGroup) => p.id)
    ).toEqual(['copy-1', 'copy-2'])

    // Once: a saved pin of that name and folder made afterwards is someone's choice.
    pinned.usePinnedStore
      .getState()
      .addPinnedGroup(savedPin({ id: 'later', name: 'Fresh', cwd: '/repo' }))
    await pinned.refreshWorkspacePins(ws)
    expect(pinned.usePinnedStore.getState().pinnedGroups.map((p) => p.id)).toContain('later')
    expect(JSON.parse(storage.store.get('clave-pin-twins-cleared')!)).toEqual([workspaceId])
  } finally {
    storage.restore()
  }
})

it('keeps the one run of a workspace whose file could not be read', async () => {
  const storage = memoryStorage()
  try {
    const ws = {
      ...workspace.useWorkspaceStore.getState().serverWorkspaces.vps[0],
      profileFile: '/repo/chosen.clave'
    }
    vi.mocked(window.electronAPI.claveFileExists).mockResolvedValue(false)
    pinned.usePinnedStore.setState({
      pinnedGroups: [savedPin({ id: 'copy-1', name: 'Fresh', cwd: '/repo' })]
    })
    await pinned.refreshWorkspacePins(ws)
    expect(pinned.usePinnedStore.getState().pinnedGroups.map((p) => p.id)).toEqual(['copy-1'])
    expect(storage.store.has('clave-pin-twins-cleared')).toBe(false)
    // The file is back: the run happens now.
    vi.mocked(window.electronAPI.claveFileExists).mockResolvedValue(true)
    await pinned.refreshWorkspacePins(ws)
    expect(pinned.usePinnedStore.getState().pinnedGroups.map((p) => p.id)).not.toContain('copy-1')
    expect(JSON.parse(storage.store.get('clave-pin-twins-cleared')!)).toEqual([workspaceId])
  } finally {
    storage.restore()
  }
})

it('removes nothing when the run cannot be recorded as done', async () => {
  // beforeAll's storage reads and cannot write: a run here would repeat at every boot.
  const ws = workspace.useWorkspaceStore.getState().serverWorkspaces.vps[0]
  pinned.usePinnedStore.setState({
    pinnedGroups: [savedPin({ id: 'copy-1', name: 'Fresh', cwd: '/repo' })]
  })
  await pinned.refreshWorkspacePins(ws)
  expect(pinned.usePinnedStore.getState().pinnedGroups.map((p) => p.id)).toContain('copy-1')
})

// ── Re-sync follows the same rule ──

const linkedPin = (): PinnedGroup =>
  savedPin({
    id: 'linked',
    activeGroupId: 'group-live',
    visible: true,
    sessions: [{ ...pin().sessions[0], name: 'Clave' }],
    terminals: [{ command: 'npm run dev', commandMode: 'auto', color: 'green', icon: 'bolt' }]
  })

it('does not read a pinned group as out of sync because of its tabs, only its terminals', () => {
  mocks.state.sessions = liveTabs()
  mocks.state.groups = [liveGroup()]
  pinned.usePinnedStore.setState({ pinnedGroups: [linkedPin()] })
  // Three tabs open against the pin's one: still in sync.
  expect(pinned.isPinnedOutOfSync('group-live')).toBe(false)
  mocks.state.groups = [
    liveGroup({ terminals: [{ ...liveGroup().terminals[0], command: 'pnpm dev' }] })
  ]
  expect(pinned.isPinnedOutOfSync('group-live')).toBe(true)
})

it("re-syncs the group and its terminals, and leaves the pin's session as declared", () => {
  mocks.state.sessions = liveTabs()
  mocks.state.groups = [
    liveGroup({
      name: 'Clave app',
      cwd: '/repo/clave-app',
      color: 'red',
      terminals: [{ ...liveGroup().terminals[0], command: 'pnpm dev' }]
    })
  ]
  const before = linkedPin()
  pinned.usePinnedStore.setState({ pinnedGroups: [before] })
  pinned.resyncPinnedGroup('group-live')
  const [after] = pinned.usePinnedStore.getState().pinnedGroups
  expect(after).toMatchObject({ name: 'Clave app', cwd: '/repo/clave-app', color: 'red' })
  expect(after.terminals).toMatchObject([{ command: 'pnpm dev' }])
  expect(after.sessions).toEqual(before.sessions)
})
