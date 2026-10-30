import { afterEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ move: vi.fn() }))
vi.mock('../store/session-store', () => ({
  useSessionStore: { getState: () => ({ moveItems: f.move }) }
}))
import { openFleetSession } from './mcp-fleet-session'
const profile = {
  id: 'remote',
  name: 'Remote only',
  family: 'codex',
  command: ['/srv/bin/codex'],
  additionalArgs: []
}
function setup(): Record<
  | 'fleetLaunchSettings'
  | 'fleetStart'
  | 'setSessionDisplayName'
  | 'fleetSnapshot'
  | 'resizeSession',
  ReturnType<typeof vi.fn>
> {
  const api = {
    fleetLaunchSettings: vi.fn().mockResolvedValue({
      profiles: { customProfiles: [profile] },
      claudeAccounts: [{ id: 'c', label: 'Remote Claude' }],
      codexAccounts: [{ id: 'x', label: 'Remote Codex' }]
    }),
    fleetStart: vi.fn().mockResolvedValue({ id: 'remote-session' }),
    setSessionDisplayName: vi.fn(),
    fleetSnapshot: vi.fn(),
    resizeSession: vi.fn()
  }
  vi.stubGlobal('window', { electronAPI: api })
  return api
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
describe('MCP fleet session launch', () => {
  it('uses the destination profile, account and flags and awaits visible inventory', async () => {
    const api = setup()
    expect(
      await openFleetSession('server', 'ws', 'group', {
        cwd: '/srv/repo',
        mode: 'codex',
        profile: 'Remote only',
        account: 'Remote Codex',
        name: 'proof',
        prompt: 'hello',
        model: 'gpt-test',
        dangerous: true
      })
    ).toEqual({ sessionId: 'remote-session', groupId: 'group', serverId: 'server' })
    expect(api.fleetLaunchSettings).toHaveBeenCalledWith('server')
    expect(api.fleetStart).toHaveBeenCalledWith(
      'server',
      '/srv/repo',
      expect.objectContaining({
        workspaceId: 'ws',
        codexMode: true,
        launchProfileId: 'remote',
        launchProfile: profile,
        codexAccountId: 'x',
        codexAccountLabel: 'Remote Codex',
        initialPrompt: 'hello',
        dangerousMode: true,
        model: 'gpt-test'
      })
    )
    expect(api.setSessionDisplayName).toHaveBeenCalledWith('remote-session', 'proof', true)
    expect(api.fleetSnapshot).toHaveBeenCalledWith('server')
    expect(f.move).toHaveBeenCalledWith(['remote-session'], 'group', 'inside')
    expect(api.resizeSession).toHaveBeenCalledWith('remote-session', 120, 30)
  })
  it('runs terminals without account/profile lookups and preserves prefill', async () => {
    const api = setup()
    await openFleetSession('server', undefined, undefined, {
      cwd: '/srv/repo',
      mode: 'terminal',
      command: 'hostname',
      autoRun: false
    })
    expect(api.fleetLaunchSettings).not.toHaveBeenCalled()
    expect(api.fleetStart).toHaveBeenCalledWith(
      'server',
      '/srv/repo',
      expect.objectContaining({ initialCommand: 'hostname', autoExecute: false })
    )
  })
  it('rejects unknown destination profiles/accounts and invalid chat modes before creating a session', async () => {
    const api = setup()
    for (const args of [
      { mode: 'codex' as const, profile: 'Mac only' },
      { mode: 'codex' as const, account: 'Mac only' },
      { mode: 'terminal' as const, chat: true },
      { mode: 'terminal' as const, account: 'x' }
    ])
      await expect(
        openFleetSession('server', undefined, undefined, { cwd: '/srv/repo', ...args })
      ).rejects.toThrow()
    expect(api.fleetStart).not.toHaveBeenCalled()
  })
  it('propagates an offline server without creating a session anywhere else', async () => {
    const api = setup()
    api.fleetStart.mockRejectedValue(new Error('offline'))
    await expect(
      openFleetSession('server', undefined, undefined, { cwd: '/', mode: 'terminal' })
    ).rejects.toThrow('offline')
    expect(api.fleetSnapshot).not.toHaveBeenCalled()
  })
})
