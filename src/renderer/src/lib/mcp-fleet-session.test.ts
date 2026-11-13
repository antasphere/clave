import { afterEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({
  move: vi.fn(),
  sessions: [] as Array<{ id: string; alive: boolean; claudeSessionId?: string }>
}))
vi.mock('../store/session-store', () => ({
  useSessionStore: { getState: () => ({ moveItems: f.move, sessions: f.sessions }) }
}))
import { assertServerConnected, openFleetSession } from './mcp-fleet-session'
import { useFleetStore } from '../store/fleet-store'
import { useProviderConnectionsStore } from '../store/provider-connections-store'
import { resourceKey } from '@clave/contract/fleet'
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
    // An explicit chat profile still wins, by id.
    await openFleetSession('server', 'ws', undefined, {
      cwd: '/srv/repo',
      mode: 'codex',
      chat: true,
      profile: 'codex-chat'
    })
    expect(api.fleetStart.mock.calls.at(-1)![2]).toMatchObject({ launchProfileId: 'codex-chat' })
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
  // Lane C of the harness wave (PRDCT-4496): Pi and OpenCode on the server's stored connections
  it('opens Pi and OpenCode on the server\'s stored connection named by id, label or "any", its list read first, and refuses an unknown one or none', async () => {
    const api = setup() as ReturnType<typeof setup> & Record<string, ReturnType<typeof vi.fn>>
    const stored = (id: string, company: string, label: string, hasKey = true): unknown => ({
      id,
      label,
      company,
      pool: company,
      kind: 'key',
      endpoints: [{ wireFormat: 'openai-chat', baseUrl: 'https://e2e-made-up.example/v1' }],
      needsKey: true,
      hasKey,
      keySetAt: null,
      createdAt: 0
    })
    const list = vi
      .fn()
      .mockResolvedValue([
        stored('c-ds', 'deepseek', 'No key yet', false),
        stored('c-kimi', 'moonshot', 'Kimi work')
      ])
    ;(
      window as unknown as { electronAPI: Record<string, unknown> }
    ).electronAPI.fleetProviderConnections = list
    useProviderConnectionsStore.setState({ byMachine: {} })
    const open = (args: Record<string, unknown>): Promise<unknown> =>
      openFleetSession('server', undefined, undefined, { cwd: '/srv/repo', ...args })
    const startedWith = (n: number): Record<string, unknown> =>
      api.fleetStart.mock.calls[n][2] as Record<string, unknown>
    await open({ mode: 'pi', account: 'c-kimi' })
    expect(list).toHaveBeenCalledWith('server')
    expect(startedWith(0)).toMatchObject({
      piMode: true,
      connectionId: 'c-kimi',
      connectionLabel: 'Kimi work'
    })
    await open({ mode: 'opencode', account: 'kimi WORK' })
    expect(startedWith(1)).toMatchObject({ opencodeMode: true, connectionId: 'c-kimi' })
    await open({ mode: 'pi', account: 'any' })
    expect(startedWith(2)).toMatchObject({ connectionId: 'c-kimi' })
    await open({ mode: 'pi' })
    expect(startedWith(3)).not.toHaveProperty('connectionId')
    await expect(open({ mode: 'pi', account: 'Nobody' })).rejects.toThrow(
      'Unknown Pi connection "Nobody". Available: "Kimi work" (c-kimi), "No key yet" (c-ds)'
    )
    useProviderConnectionsStore.setState({
      byMachine: { server: { connections: [], loading: false, error: null } }
    })
    await expect(open({ mode: 'pi', account: 'any' })).rejects.toThrow(
      'No stored connection serves Pi yet: add one in Settings → Connections.'
    )
    // Antigravity has no pool: still refused.
    await expect(open({ mode: 'antigravity', account: 'x' })).rejects.toThrow(
      'The account argument applies to claude, codex, pi and opencode modes only (got mode "antigravity")'
    )
    expect(api.fleetStart).toHaveBeenCalledTimes(4)
  })
  it('reopens a resumed conversation on the profile and the server account it ran on, unless the call names its account (PRDCT-4321)', async () => {
    const api = setup()
    const resumed = {
      cwd: '/srv/repo',
      mode: 'claude' as const,
      resumeSessionId: 'conv-1',
      resumeLaunchProfileId: 'chat:claude:mine',
      resumeAccount: { id: 'srv-acct', label: 'Studio work' }
    }
    await openFleetSession('server', undefined, undefined, resumed)
    expect(api.fleetStart.mock.calls.at(-1)![2]).toMatchObject({
      claudeMode: true,
      resumeSessionId: 'conv-1',
      launchProfileId: 'chat:claude:mine',
      claudeProfileId: 'srv-acct',
      claudeProfileLabel: 'Studio work'
    })
    // The call's own account wins.
    await openFleetSession('server', undefined, undefined, { ...resumed, account: 'Remote Claude' })
    expect(api.fleetStart.mock.calls.at(-1)![2]).toMatchObject({
      claudeProfileId: 'c',
      claudeProfileLabel: 'Remote Claude'
    })
    // A codex resume never takes a Claude account.
    await openFleetSession('server', undefined, undefined, { ...resumed, mode: 'codex' })
    expect(api.fleetStart.mock.calls.at(-1)![2].claudeProfileId).toBeUndefined()
  })
  it('answers a resume with the stopped tab of that server that holds the conversation, restarted in place (PRDCT-4321)', async () => {
    const api = setup() as ReturnType<typeof setup> & { restartSession: ReturnType<typeof vi.fn> }
    api.restartSession = vi.fn().mockResolvedValue({ id: 'held' })
    const held = resourceKey('session', 'server', 'tab-9')
    const elsewhere = resourceKey('session', 'other', 'tab-1')
    f.sessions.push(
      { id: elsewhere, alive: false, claudeSessionId: 'conv-x' },
      { id: held, alive: false, claudeSessionId: 'conv-x' }
    )
    try {
      const result = await openFleetSession('server', undefined, undefined, {
        cwd: '/srv/app',
        mode: 'claude',
        resumeSessionId: 'conv-x'
      })
      expect(result.sessionId).toBe(held)
      expect(api.restartSession).toHaveBeenCalledWith(held, { onlyIfStopped: true })
      expect(api.fleetStart).not.toHaveBeenCalled()
      // No holder on this server: a new tab on the conversation.
      await openFleetSession('server', undefined, undefined, {
        cwd: '/srv/app',
        mode: 'claude',
        resumeSessionId: 'conv-y'
      })
      expect(api.fleetStart).toHaveBeenCalledTimes(1)
    } finally {
      f.sessions.splice(0)
    }
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
