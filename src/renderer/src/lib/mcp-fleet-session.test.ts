import { afterEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ move: vi.fn() }))
vi.mock('../store/session-store', () => ({
  useSessionStore: { getState: () => ({ moveItems: f.move }) }
}))
import { assertServerConnected, openFleetSession } from './mcp-fleet-session'
import { useFleetStore } from '../store/fleet-store'
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
  it("opens a chat on the server's own global default's chat form, the built-in otherwise", async () => {
    const api = setup()
    const yolo = {
      id: 'yolo',
      name: 'yolo codex',
      family: 'codex',
      command: ['codex', '--yolo'],
      additionalArgs: []
    }
    const yoloChat = {
      ...yolo,
      id: 'chat:codex:yolo',
      name: 'yolo codex (chat)',
      sourceProfileId: 'yolo'
    }
    const codexChat = {
      id: 'codex-chat',
      name: 'Codex (chat)',
      family: 'codex',
      command: ['codex'],
      additionalArgs: [],
      builtIn: true
    }
    api.fleetLaunchSettings.mockResolvedValue({
      profiles: {
        customProfiles: [profile, yolo, yoloChat, codexChat],
        globalDefaults: { codex: 'yolo' },
        // A Mac-side workspace key the server never holds: not consulted.
        workspaceOverrides: { ws: { codex: 'codex-chat' } }
      },
      claudeAccounts: [],
      codexAccounts: [{ id: 'x', label: 'Remote Codex' }]
    })
    await openFleetSession('server', 'ws', undefined, {
      cwd: '/srv/repo',
      mode: 'codex',
      chat: true
    })
    expect(api.fleetStart.mock.calls.at(-1)![2]).toMatchObject({
      launchProfileId: 'chat:codex:yolo',
      launchProfile: yoloChat
    })
    // A generic chat ID follows this server's default, not the Mac's.
    await openFleetSession('server', 'ws', undefined, {
      cwd: '/srv/repo',
      mode: 'codex',
      chat: true,
      profile: 'codex-chat'
    })
    expect(api.fleetStart.mock.calls.at(-1)![2]).toMatchObject({
      launchProfileId: 'chat:codex:yolo',
      launchProfile: yoloChat
    })
    await openFleetSession('server', 'ws', undefined, {
      cwd: '/srv/repo',
      mode: 'codex',
      profile: 'codex-chat'
    })
    expect(api.fleetStart.mock.calls.at(-1)![2]).toMatchObject({
      launchProfileId: 'chat:codex:yolo',
      launchProfile: { command: ['codex', '--yolo'] },
      dangerousMode: false
    })
    // No default on the server: the built-in chat.
    api.fleetLaunchSettings.mockResolvedValue({
      profiles: { customProfiles: [codexChat], globalDefaults: {}, workspaceOverrides: {} },
      claudeAccounts: [],
      codexAccounts: []
    })
    await openFleetSession('server', undefined, undefined, {
      cwd: '/srv/repo',
      mode: 'codex',
      chat: true
    })
    expect(api.fleetStart.mock.calls.at(-1)![2]).toMatchObject({ launchProfileId: 'codex-chat' })
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
  it('carries same-server attachment only when explicitly requested', async () => {
    const api = setup()
    for (const attachToParent of [false, true]) {
      await openFleetSession('server', undefined, undefined, {
        cwd: '/srv/repo',
        mode: 'terminal',
        callerSessionId: 'parent',
        attachToParent
      })
      const options = api.fleetStart.mock.calls.at(-1)![2]
      expect(options.spawnedBy).toBe(attachToParent ? 'parent' : undefined)
    }
  })
  it('refuses a server the window shows as off, in the Servers page’s words, and lets a connecting one through (PRDCT-4165)', async () => {
    const api = setup()
    const studio = { id: 'studio', name: 'Studio', url: 'http://studio:1', enabled: true }
    const set = (
      statuses: Record<string, { serverId: string; state: string; error?: string }>,
      enabled = true
    ): void =>
      useFleetStore.setState({
        connections: [{ ...studio, enabled }],
        statuses: statuses as never
      })
    set({ studio: { serverId: 'studio', state: 'offline', error: 'unreachable' } })
    await expect(
      openFleetSession('studio', undefined, undefined, { cwd: '/', mode: 'terminal' })
    ).rejects.toThrow(
      'Studio is unreachable. The server did not answer at this address. Check the address and that the server is running.'
    )
    set({ studio: { serverId: 'studio', state: 'unauthorized', error: 'unauthorized' } })
    expect(() => assertServerConnected('studio')).toThrow(
      'Studio refused its token. The server refused the token. Remove this server and add it again with its current token.'
    )
    set({}, false)
    expect(() => assertServerConnected('studio')).toThrow(
      'Studio is disconnected. Reconnect it in Settings → Servers.'
    )
    expect(api.fleetStart).not.toHaveBeenCalled()
    // Connecting, reconnecting, or not reported yet: the fleet client waits for the welcome.
    for (const state of ['connecting', 'reconnecting', 'connected'])
      expect(() => {
        set({ studio: { serverId: 'studio', state } })
        assertServerConnected('studio')
      }).not.toThrow()
    set({})
    expect(() => assertServerConnected('studio')).not.toThrow()
    // A server the window never saved is the fleet client's to refuse.
    expect(() => assertServerConnected('elsewhere')).not.toThrow()
    useFleetStore.setState({ connections: [], statuses: {} })
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
