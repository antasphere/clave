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
  accountForLaunch: (_provider: string, id: string) => ({ id: f.accountId ?? id })
}))
vi.mock('../store/workspace-store', () => ({
  getActiveWorkspaceId: () => f.activeWorkspaceId,
  getWorkspaceById: (id: string) => f.workspaces.get(id) ?? null,
  workspaceServer: (id: string | null) =>
    id?.startsWith('clave-owner:workspace:') ? decodeURIComponent(id.split(':')[2]) : null
}))
vi.mock('../store/launch-prefs', () => ({
  agentAcceptsPrompt: () => true,
  agentSetupToModes: () => ({ codexMode: true }),
  rememberAgentSetup: f.remember
}))
import { launchSession } from './launch-session'

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  f.accountId = null
  f.focusedSessionId = null
  f.activeWorkspaceId = 'workspace'
  f.workspaces.clear()
  f.statuses = {}
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
