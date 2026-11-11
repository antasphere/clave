import { afterEach, describe, expect, it, vi } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'

const f = vi.hoisted(() => ({
  add: vi.fn(),
  spawn: vi.fn(),
  remember: vi.fn(),
  list: vi.fn(),
  kill: vi.fn(),
  fleetStart: vi.fn(),
  fleetSnapshot: vi.fn(),
  moveItems: vi.fn(),
  setState: vi.fn(),
  pickFolder: vi.fn(),
  notice: vi.fn(),
  focusedSessionId: null as string | null,
  accountId: null as string | null,
  accountCalls: [] as [string, string | undefined, string | undefined][],
  launchModel: vi.fn(async () => undefined as string | undefined),
  modes: { codexMode: true } as Record<string, boolean>,
  activeWorkspaceId: 'workspace' as string | null,
  workspaces: new Map<string, { id: string; rootDir: string }>(),
  statuses: {} as Record<string, { state: string }>
}))
vi.mock('../store/session-store', () => ({
  useSessionStore: {
    getState: () => ({
      addSessionInGroup: f.add,
      moveItems: f.moveItems,
      sessions: [],
      focusedSessionId: f.focusedSessionId
    }),
    setState: f.setState
  }
}))
vi.mock('../store/fleet-store', () => ({
  useFleetStore: {
    getState: () => ({
      connections: [{ id: 'fixture-remote', name: 'Studio server' }],
      statuses: f.statuses
    })
  }
}))
vi.mock('../store/server-folder-store', () => ({ pickServerFolder: f.pickFolder }))
vi.mock('../store/launch-notice-store', () => ({
  showLaunchNotice: f.notice,
  clearLaunchNotice: () => {}
}))
vi.mock('../store/claude-profile-store', () => ({
  claudeProfileSpawnFields: (p: { id: string }) => ({ claudeProfileId: p.id })
}))
vi.mock('../store/codex-account-store', () => ({
  codexAccountSpawnFields: (p: { id: string }) => ({ codexAccountId: p.id })
}))
vi.mock('./switch-account', () => ({
  accountForLaunch: (provider: string, id: string, model?: string) => {
    f.accountCalls.push([provider, id, model])
    return { id: f.accountId ?? id }
  }
}))
vi.mock('./launch-model', () => ({ rememberedLaunchModel: f.launchModel }))
vi.mock('../store/workspace-store', () => ({
  getActiveWorkspaceId: () => f.activeWorkspaceId,
  getWorkspaceById: (id: string) => f.workspaces.get(id) ?? null,
  workspaceServer: (id: string | null) =>
    id?.startsWith('clave-owner:workspace:') ? decodeURIComponent(id.split(':')[2]) : null
}))
vi.mock('../store/launch-prefs', () => ({
  agentAcceptsPrompt: () => true,
  agentSetupToModes: () => f.modes,
  rememberAgentSetup: f.remember
}))
import { launchSession } from './launch-session'
import { useLaunchSettingsStore } from '../store/launch-settings-store'

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  f.accountId = null
  f.accountCalls = []
  f.launchModel.mockReset()
  f.launchModel.mockResolvedValue(undefined)
  f.modes = { codexMode: true }
  f.focusedSessionId = null
  f.activeWorkspaceId = 'workspace'
  f.workspaces.clear()
  f.statuses = {}
  useLaunchSettingsStore.setState({ harnesses: {} })
})

describe('launchSession acknowledgement and opt-in errors', () => {
  const request = {
    cwd: { kind: 'path' as const, path: '/private/triage' },
    setup: {
      kind: 'codex' as const,
      dangerousMode: false,
      launchProfileId: 'codex-work',
      codexAccountId: 'work'
    },
    initialPrompt: 'Read this capture',
    workspaceId: 'capture-workspace',
    remember: false
  }
  it('retains the created id before placement, preserves selections, and writes no default', async () => {
    vi.stubGlobal('window', { electronAPI: { spawnSession: f.spawn } })
    const onCreated = vi.fn()
    f.spawn.mockResolvedValue({
      id: 'new',
      cwd: '/private/triage',
      folderName: 'triage',
      alive: true
    })
    f.add.mockImplementation(() => expect(onCreated).toHaveBeenCalledWith('new'))
    expect(await launchSession({ ...request, onCreated, throwOnError: true })).toBe('new')
    expect(f.spawn).toHaveBeenCalledWith(
      '/private/triage',
      expect.objectContaining({
        codexAccountId: 'work',
        launchProfileId: 'codex-work',
        dangerousMode: false,
        initialPrompt: 'Read this capture',
        workspaceId: 'capture-workspace'
      })
    )
    expect(f.add.mock.calls[0][1]).toBeNull()
    expect(f.add.mock.calls[0][0].workspaceId).toBe('capture-workspace')
    expect(f.remember).not.toHaveBeenCalled()
  })
  it('keeps a launch in a Mac workspace on this Mac while a remote session is focused', async () => {
    vi.stubGlobal('window', { electronAPI: { spawnSession: f.spawn, fleetStart: f.fleetStart } })
    f.focusedSessionId = resourceKey('session', 'fixture-remote', 'working-chat')
    f.spawn.mockResolvedValue({ id: 'local-support' })
    const onCreated = vi.fn()
    expect(await launchSession({ ...request, onCreated })).toBe('local-support')
    expect(f.fleetStart).not.toHaveBeenCalled()
    expect(f.spawn).toHaveBeenCalledWith(
      '/private/triage',
      expect.objectContaining({
        codexAccountId: 'work',
        launchProfileId: 'codex-work',
        workspaceId: 'capture-workspace'
      })
    )
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('local-support')
  })

  it('keeps explicit remote launches remote when a local session is focused', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        spawnSession: f.spawn,
        fleetStart: f.fleetStart,
        fleetSnapshot: f.fleetSnapshot
      }
    })
    f.statuses = { 'fixture-remote': { state: 'connected' } }
    f.focusedSessionId = 'local-chat'
    f.fleetStart.mockResolvedValue({ id: resourceKey('session', 'fixture-remote', 'new') })
    expect(
      await launchSession({ ...request, workspaceId: undefined, serverId: 'fixture-remote' })
    ).toBe(resourceKey('session', 'fixture-remote', 'new'))
    expect(f.fleetStart).toHaveBeenCalledWith(
      'fixture-remote',
      '/private/triage',
      expect.anything()
    )
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('propagates provider errors when requested without creating a renderer tab', async () => {
    vi.stubGlobal('window', { electronAPI: { spawnSession: f.spawn } })
    const failure = new Error('adapter unavailable')
    f.spawn.mockRejectedValue(failure)
    await expect(launchSession({ ...request, throwOnError: true })).rejects.toBe(failure)
    expect(f.add).not.toHaveBeenCalled()
  })
  it('makes creation known even when placement subsequently fails', async () => {
    vi.stubGlobal('window', { electronAPI: { spawnSession: f.spawn } })
    f.spawn.mockResolvedValue({ id: 'new' })
    f.add.mockImplementation(() => {
      throw new Error('placement')
    })
    const onCreated = vi.fn()
    await expect(launchSession({ ...request, throwOnError: true, onCreated })).rejects.toThrow(
      'placement'
    )
    expect(onCreated).toHaveBeenCalledWith('new')
  })

  it('rejects a fallback before placement and removes only its new unused terminal handle', async () => {
    vi.stubGlobal('window', {
      electronAPI: { spawnSession: f.spawn, sessionsList: f.list, killSession: f.kill }
    })
    const existing = { id: 'existing', transport: 'pty', state: 'working' }
    f.list
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([existing, { id: 'new', transport: 'pty', state: 'idle' }])
      .mockResolvedValueOnce([existing])
    f.spawn.mockResolvedValue({ id: 'new', launchProfileId: 'builtin-codex' })
    const onCreated = vi.fn()
    await expect(
      launchSession({ ...request, exactProfile: true, throwOnError: true, onCreated })
    ).rejects.toMatchObject({ code: 'launch-profile-mismatch', cleanupSucceeded: true })
    expect(f.kill).toHaveBeenCalledExactlyOnceWith('new')
    expect(f.add).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it.each(['existing', 'events', 'working'])(
    'never cleans up a mismatched %s handle',
    async (kind) => {
      vi.stubGlobal('window', {
        electronAPI: { spawnSession: f.spawn, sessionsList: f.list, killSession: f.kill }
      })
      const id = kind === 'existing' ? 'existing' : 'new'
      f.list.mockResolvedValueOnce([{ id: 'existing' }]).mockResolvedValueOnce([
        {
          id,
          transport: kind === 'events' ? 'events' : 'pty',
          state: kind === 'working' ? 'working' : 'idle'
        }
      ])
      f.spawn.mockResolvedValue({ id, launchProfileId: 'unexpected' })
      await expect(
        launchSession({ ...request, exactProfile: true, throwOnError: true })
      ).rejects.toMatchObject({ code: 'launch-profile-mismatch', cleanupSucceeded: false })
      expect(f.kill).not.toHaveBeenCalled()
      expect(f.add).not.toHaveBeenCalled()
    }
  )

  it("judges the account for the model the launch will run (PRDCT-4302): the launcher's account button and the keyboard pass their chat's remembered model", async () => {
    vi.stubGlobal('window', { electronAPI: { spawnSession: f.spawn } })
    f.spawn.mockResolvedValue({
      id: 'new',
      cwd: '/private/triage',
      folderName: 'triage',
      alive: true
    })
    f.launchModel.mockResolvedValue('gpt-5.5')
    await launchSession({ ...request, throwOnError: true })
    // The model is read for the launch's profile in the launch's workspace.
    expect(f.launchModel).toHaveBeenCalledWith('codex', 'codex-work', 'capture-workspace')
    expect(f.accountCalls).toEqual([['codex', 'work', 'gpt-5.5']])
  })

  it("judges a Claude chat's account for its remembered model too (round 1, L1)", async () => {
    vi.stubGlobal('window', { electronAPI: { spawnSession: f.spawn } })
    f.spawn.mockResolvedValue({
      id: 'new',
      cwd: '/private/triage',
      folderName: 'triage',
      alive: true
    })
    f.modes = { claudeMode: true }
    f.launchModel.mockResolvedValue('claude-opus-5-5')
    await launchSession({
      ...request,
      setup: {
        kind: 'claude',
        dangerousMode: false,
        launchProfileId: 'claude-chat',
        claudeProfileId: 'mac'
      },
      throwOnError: true
    })
    expect(f.launchModel).toHaveBeenCalledWith('claude', 'claude-chat', 'capture-workspace')
    expect(f.accountCalls).toEqual([['claude', 'mac', 'claude-opus-5-5']])
    expect(f.spawn).toHaveBeenCalledWith(
      '/private/triage',
      expect.objectContaining({ claudeProfileId: 'mac' })
    )
  })

  it('judges a launch whose model this Mac cannot know on the shared caps alone', async () => {
    vi.stubGlobal('window', { electronAPI: { spawnSession: f.spawn } })
    f.spawn.mockResolvedValue({
      id: 'new',
      cwd: '/private/triage',
      folderName: 'triage',
      alive: true
    })
    await launchSession({ ...request, throwOnError: true })
    expect(f.accountCalls).toEqual([['codex', 'work', undefined]])
  })

  it('judges the account on the model picked in the launcher and passes it and the permission rung to the spawn (PRDCT-4423)', async () => {
    vi.stubGlobal('window', { electronAPI: { spawnSession: f.spawn } })
    f.spawn.mockResolvedValue({ id: 'new', cwd: '/private/triage', folderName: 'triage' })
    f.modes = { claudeMode: true }
    f.launchModel.mockResolvedValue('claude-opus-5-5')
    useLaunchSettingsStore.setState({
      harnesses: { claude: { permissionDefault: 'acceptEdits' } }
    })
    await launchSession({
      ...request,
      setup: {
        kind: 'claude',
        dangerousMode: false,
        launchProfileId: 'claude-chat',
        model: 'claude-fable-5-1[1m]'
      },
      throwOnError: true
    })
    // The picked model wins over the composer's remembered one.
    expect(f.accountCalls).toEqual([['claude', undefined, 'claude-fable-5-1[1m]']])
    expect(f.spawn).toHaveBeenCalledWith(
      '/private/triage',
      expect.objectContaining({ model: 'claude-fable-5-1[1m]', permissionMode: 'acceptEdits' })
    )
  })

  it('never sends a rung with a skip-approvals launch, nor a model it was not given', async () => {
    vi.stubGlobal('window', { electronAPI: { spawnSession: f.spawn } })
    f.spawn.mockResolvedValue({ id: 'new', cwd: '/private/triage', folderName: 'triage' })
    useLaunchSettingsStore.setState({
      harnesses: { codex: { permissionDefault: 'workspace-write' } }
    })
    await launchSession({
      ...request,
      setup: { ...request.setup, dangerousMode: true },
      throwOnError: true
    })
    const options = f.spawn.mock.calls[0][1]
    expect(options.dangerousMode).toBe(true)
    expect(options).not.toHaveProperty('permissionMode')
    expect(options).not.toHaveProperty('model')
    f.spawn.mockClear()
    await launchSession({ ...request, throwOnError: true })
    expect(f.spawn.mock.calls[0][1]).toMatchObject({ permissionMode: 'workspace-write' })
  })

  it('rejects a different account from the existing pool helper before any spawn', async () => {
    vi.stubGlobal('window', {
      electronAPI: { spawnSession: f.spawn, sessionsList: f.list, killSession: f.kill }
    })
    f.accountId = 'another-account'
    await expect(
      launchSession({ ...request, exactProfile: true, throwOnError: true })
    ).rejects.toMatchObject({ code: 'launch-account-unavailable', cleanupSucceeded: true })
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.kill).not.toHaveBeenCalled()
  })
})

describe('launches in a server workspace (#241)', () => {
  const serverWorkspace = resourceKey('workspace', 'fixture-remote', 'ws-1')
  const setup = {
    kind: 'claude' as const,
    dangerousMode: true,
    launchProfileId: 'claude-work',
    claudeProfileId: 'mac-account'
  }
  const withServer = (): void => {
    vi.stubGlobal('window', {
      electronAPI: {
        spawnSession: f.spawn,
        fleetStart: f.fleetStart,
        fleetSnapshot: f.fleetSnapshot,
        openFolderDialog: vi.fn(),
        claveFileExists: vi.fn()
      }
    })
    f.activeWorkspaceId = serverWorkspace
    f.workspaces.set(serverWorkspace, { id: serverWorkspace, rootDir: '/srv/repo' })
    f.statuses = { 'fixture-remote': { state: 'connected' } }
    f.fleetStart.mockResolvedValue({ id: resourceKey('session', 'fixture-remote', 'new') })
    f.fleetSnapshot.mockResolvedValue(undefined)
  }

  it('starts on the server at the workspace root with the launch profile, never a Mac account', async () => {
    withServer()
    const id = await launchSession({ setup, cwd: { kind: 'workspace-root' }, remember: true })
    expect(id).toBe(resourceKey('session', 'fixture-remote', 'new'))
    expect(f.fleetStart).toHaveBeenCalledExactlyOnceWith('fixture-remote', '/srv/repo', {
      codexMode: true,
      dangerousMode: true,
      launchProfileId: 'claude-work',
      workspaceId: serverWorkspace
    })
    const options = f.fleetStart.mock.calls[0][2]
    expect(options).not.toHaveProperty('claudeProfileId')
    expect(options).not.toHaveProperty('codexAccountId')
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.fleetSnapshot).toHaveBeenCalledWith('fixture-remote')
    expect(f.setState).toHaveBeenCalledWith(
      expect.objectContaining({ focusedSessionId: id, selectedSessionIds: [id] })
    )
    expect(f.remember).toHaveBeenCalledWith(serverWorkspace, setup)
  })

  it('sends the server’s own profile definition and account when the setup names them, reading the server first when it was not read yet (PRDCT-4162)', async () => {
    withServer()
    // The modes rule is mocked to Codex above, so the pick exercised is a Codex one.
    const { registerServerSettingsLoader, useServerSettingsStore } =
      await import('../store/server-settings-state')
    const serverProfile = {
      id: 'srv-recorder',
      name: 'Server recorder',
      family: 'codex' as const,
      command: ['/srv/bin/codex'],
      additionalArgs: []
    }
    const filled = {
      status: 'ready' as const,
      error: null,
      claude: [{ id: 'default', label: 'Default' }],
      codex: [
        { id: 'default', label: 'Default' },
        { id: 'srv-acc', label: 'Second server account' }
      ],
      migrated: [],
      profiles: {
        version: 1 as const,
        customProfiles: [serverProfile],
        globalDefaults: {},
        workspaceOverrides: {}
      },
      usage: { claude: {}, codex: {} }
    }
    // Not read yet: the launch reads the server first, through the registered loader.
    const load = vi.fn(async (serverId: string) => {
      useServerSettingsStore.setState({ byServer: { [serverId]: filled as never } })
    })
    registerServerSettingsLoader(load)
    useServerSettingsStore.setState({ byServer: {} })
    await launchSession({
      setup: {
        kind: 'codex',
        dangerousMode: false,
        launchProfileId: 'srv-recorder',
        codexAccountId: 'srv-acc'
      },
      cwd: { kind: 'workspace-root' }
    })
    expect(load).toHaveBeenCalledWith('fixture-remote')
    expect(f.fleetStart.mock.calls[0][2]).toMatchObject({
      launchProfileId: 'srv-recorder',
      launchProfile: serverProfile,
      codexAccountId: 'srv-acc',
      codexAccountLabel: 'Second server account'
    })
    // Already read: no second read; a Mac account the server does not list never travels.
    f.fleetStart.mockClear()
    await launchSession({
      setup: {
        kind: 'codex',
        dangerousMode: false,
        launchProfileId: 'codex-work',
        codexAccountId: 'mac-account'
      },
      cwd: { kind: 'workspace-root' }
    })
    expect(load).toHaveBeenCalledTimes(1)
    const options = f.fleetStart.mock.calls[0][2]
    expect(options).toMatchObject({ launchProfileId: 'codex-work' })
    expect(options).not.toHaveProperty('launchProfile')
    expect(options).not.toHaveProperty('codexAccountId')
    useServerSettingsStore.setState({ byServer: {} })
    registerServerSettingsLoader(async () => undefined)
  })

  it('asks for a folder on the server, opened at the workspace root, for ⌥', async () => {
    withServer()
    f.pickFolder.mockResolvedValue('/srv/repo/sub')
    await launchSession({ setup: null, cwd: { kind: 'ask' } })
    expect(f.pickFolder).toHaveBeenCalledWith({
      serverId: 'fixture-remote',
      serverName: 'Studio server',
      startPath: '/srv/repo'
    })
    expect(f.fleetStart).toHaveBeenCalledWith(
      'fixture-remote',
      '/srv/repo/sub',
      expect.objectContaining({ claudeMode: false })
    )
    expect(window.electronAPI.openFolderDialog).not.toHaveBeenCalled()
  })

  it('starts nothing when the server folder pick is cancelled', async () => {
    withServer()
    f.pickFolder.mockResolvedValue(null)
    expect(await launchSession({ setup, cwd: { kind: 'ask' } })).toBeNull()
    expect(f.fleetStart).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('places a group + launch in the group of its server', async () => {
    withServer()
    const groupId = resourceKey('group', 'fixture-remote', 'g')
    await launchSession({ setup, cwd: { kind: 'path', path: '/srv/repo/pkg' }, groupId })
    expect(f.fleetStart).toHaveBeenCalledWith(
      'fixture-remote',
      '/srv/repo/pkg',
      expect.objectContaining({ workspaceId: serverWorkspace })
    )
    expect(f.moveItems).toHaveBeenCalledWith(
      [resourceKey('session', 'fixture-remote', 'new')],
      groupId,
      'inside'
    )
  })

  it('launches a local group + on this Mac even in a server workspace', async () => {
    withServer()
    f.spawn.mockResolvedValue({ id: 'local-new' })
    await launchSession({ setup, cwd: { kind: 'path', path: '/mac/x' }, groupId: 'local-group' })
    expect(f.fleetStart).not.toHaveBeenCalled()
    expect(f.spawn).toHaveBeenCalledWith('/mac/x', expect.anything())
  })

  it('refuses with a notice when the server is offline', async () => {
    withServer()
    f.statuses = { 'fixture-remote': { state: 'disconnected' } }
    expect(await launchSession({ setup, cwd: { kind: 'workspace-root' } })).toBeNull()
    expect(f.fleetStart).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Studio server is offline'))
    await expect(
      launchSession({ setup, cwd: { kind: 'workspace-root' }, throwOnError: true })
    ).rejects.toThrow('offline')
  })

  it('shows a notice when the server refuses the start', async () => {
    withServer()
    f.fleetStart.mockRejectedValue(new Error('no such profile'))
    expect(await launchSession({ setup, cwd: { kind: 'workspace-root' } })).toBeNull()
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('could not start the session'))
    expect(f.setState).not.toHaveBeenCalled()
  })
})
