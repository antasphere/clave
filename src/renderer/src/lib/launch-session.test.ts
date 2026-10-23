import { afterEach, describe, expect, it, vi } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'

const f = vi.hoisted(() => ({
  add: vi.fn(),
  spawn: vi.fn(),
  remember: vi.fn(),
  list: vi.fn(),
  kill: vi.fn(),
  fleetLaunch: vi.fn(),
  focusedSessionId: null as string | null,
  accountId: null as string | null
}))
vi.mock('../store/session-store', () => ({
  useSessionStore: {
    getState: () => ({
      addSessionInGroup: f.add,
      sessions: [],
      focusedSessionId: f.focusedSessionId
    })
  }
}))
vi.mock('../store/fleet-launch-store', () => ({ requestFleetLaunch: f.fleetLaunch }))
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
  getActiveWorkspaceId: () => 'workspace',
  getWorkspaceById: () => null
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
  it('keeps an explicitly local capture local while a remote session is focused', async () => {
    vi.stubGlobal('window', { electronAPI: { spawnSession: f.spawn } })
    f.focusedSessionId = resourceKey('session', 'fixture-remote', 'working-chat')
    f.fleetLaunch.mockResolvedValue('remote-new')
    f.spawn.mockResolvedValue({ id: 'local-support' })
    const onCreated = vi.fn()
    expect(await launchSession({ ...request, serverId: 'local', onCreated })).toBe('local-support')
    expect(f.fleetLaunch).not.toHaveBeenCalled()
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

  it('keeps ordinary launches on the focused remote server', async () => {
    f.focusedSessionId = resourceKey('session', 'fixture-remote', 'working-chat')
    f.fleetLaunch.mockResolvedValue('remote-new')
    expect(await launchSession(request)).toBe('remote-new')
    expect(f.fleetLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'fixture-remote',
        cwd: '/private/triage'
      })
    )
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('keeps explicit remote launches remote when a local session is focused', async () => {
    f.focusedSessionId = 'local-chat'
    f.fleetLaunch.mockResolvedValue('remote-new')
    expect(await launchSession({ ...request, serverId: 'fixture-remote' })).toBe('remote-new')
    expect(f.fleetLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'fixture-remote' })
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
