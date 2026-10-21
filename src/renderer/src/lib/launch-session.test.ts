import { afterEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({ add: vi.fn(), spawn: vi.fn(), remember: vi.fn() }))
vi.mock('../store/session-store', () => ({
  useSessionStore: { getState: () => ({ addSessionInGroup: f.add }) }
}))
vi.mock('../store/claude-profile-store', () => ({
  claudeProfileSpawnFields: (p: { id: string }) => ({ claudeProfileId: p.id })
}))
vi.mock('../store/codex-account-store', () => ({
  codexAccountSpawnFields: (p: { id: string }) => ({ codexAccountId: p.id })
}))
vi.mock('./switch-account', () => ({
  accountForLaunch: (_provider: string, id: string) => ({ id })
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
        initialPrompt: 'Read this capture'
      })
    )
    expect(f.add.mock.calls[0][1]).toBeNull()
    expect(f.remember).not.toHaveBeenCalled()
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
})
