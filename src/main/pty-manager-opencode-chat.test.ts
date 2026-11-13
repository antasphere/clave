import { beforeEach, describe, expect, it, vi } from 'vitest'

// Lane D (PRDCT-4427): OpenCode opens in Clave's chat views through the ACP
// adapter. These pin the facade's half: the spawn configures the adapter with
// the binary and `acp` alone on the login shell's environment, writes the
// tab's record with OpenCode's own fields and no account, keeps the session
// id the agent opened, passes a resumed id as given, answers allow itself
// when the launch skips the permissions, and the restart onto the terminal
// resumes the same OpenCode session (`opencode --session <id>`).

const mocks = vi.hoisted(() => {
  const handles = new Map<string, { id: string; adapterId?: string }>()
  return {
    handles,
    backend: {
      writeEventSessionRecord: vi.fn<(record: Record<string, unknown>) => boolean>(() => true),
      discardSessionRecord: vi.fn(),
      setSessionViewRecord: vi.fn(),
      setSessionWorkspace: vi.fn(),
      setSessionClaudeSessionId: vi.fn(),
      setSessionRuntime: vi.fn(),
      setSessionCodexThreadId: vi.fn(),
      setSessionOpencodeSessionId: vi.fn(),
      getSessionRecord: vi.fn<(id: string) => unknown>(() => null),
      tmuxNameOf: vi.fn(() => null),
      waitForTmuxSessionGone: vi.fn(async () => undefined),
      listAdoptableSessions: vi.fn(() => []),
      getSession: vi.fn(() => undefined),
      getAllSessions: vi.fn(() => [])
    },
    buildSpawnEnv: vi.fn<
      (base: Record<string, string>, account: Record<string, unknown>) => Record<string, string>
    >((base) => ({ ...base, TERM: 'xterm-256color' })),
    pty: { id: 'pty', provider: 'terminal', prepare: vi.fn(), detach: vi.fn() },
    claude: {
      id: 'claude-chat',
      provider: 'claude',
      configure: vi.fn(),
      spawn: vi.fn(async (spec: { id: string }) => ({ id: spec.id })),
      kill: vi.fn(async () => undefined)
    },
    codex: {
      id: 'codex-chat',
      provider: 'codex',
      configure: vi.fn(),
      spawn: vi.fn(async (spec: { id: string }) => ({ id: spec.id })),
      kill: vi.fn(async () => undefined)
    },
    opencode: {
      id: 'opencode-chat',
      provider: 'opencode',
      configure: vi.fn(),
      spawn: vi.fn(async (spec: { id: string }) => ({ id: spec.id })),
      kill: vi.fn(async () => undefined)
    },
    acpSpecs: [] as unknown[],
    /** The command the resolved OpenCode profile runs, when a test sets one. */
    opencodeCommand: ['opencode'] as string[],
    streams: new Map<string, (stream: unknown) => void>(),
    title: { scheduleChatTitle: vi.fn(), cleanup: vi.fn(), cancelAll: vi.fn(), shutdown: vi.fn() },
    manager: {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      adopt: vi.fn((record: { id: string; adapterId?: string }) => handles.set(record.id, record)),
      get: vi.fn((id: string) => handles.get(id)),
      kill: vi.fn(async () => undefined),
      forget: vi.fn((id: string) => handles.delete(id)),
      list: vi.fn(() => [...handles.values()]),
      subscribe: vi.fn(),
      subscribeExit: vi.fn(() => () => undefined)
    }
  }
})

vi.mock('./sessions/adapters/pty-backend', () => ({
  ptyBackend: mocks.backend,
  accountTokenForSpawn: async () => undefined,
  buildSpawnEnv: mocks.buildSpawnEnv,
  codexHomeForSpawn: () => undefined,
  getLoginShellEnv: () => ({ PATH: '/login/bin', LOGIN_SHELL: 'yes' })
}))
// The stored connection's half (PRDCT-4496): what the store would open,
// stood in for; nothing for a launch on no connection.
const injection = vi.hoisted(() => ({
  forSpawn: vi.fn<
    (
      kind: string | null,
      options: { connectionId?: string; model?: string }
    ) => Promise<Record<string, unknown>>
  >(async () => ({}))
}))
vi.mock('./provider-injection-spawn', () => ({
  providerInjectionForSpawn: injection.forSpawn,
  piSessionLookupEnv: () => ({ PATH: '/login/bin', LOGIN_SHELL: 'yes' })
}))
vi.mock('./session-history/codex', () => ({
  codexRoot: () => '/codex/sessions',
  findCodexThreadForSession: () => null,
  hasCodexRollout: () => false
}))
vi.mock('./sessions/adapters/pty-adapter', () => ({ ptyAdapter: mocks.pty }))
vi.mock('./sessions/adapters/claude-adapter', () => ({
  ClaudeAdapter: class {
    constructor() {
      return mocks.claude
    }
  },
  // No transcript anywhere: the Claude guard would drop any resume.
  findTranscript: () => null
}))
vi.mock('./sessions/adapters/codex-adapter', () => ({
  CodexAdapter: class {
    constructor() {
      return mocks.codex
    }
  }
}))
vi.mock('./sessions/adapters/acp-adapter', () => ({
  AcpAdapter: class {
    constructor(spec: unknown) {
      mocks.acpSpecs.push(spec)
      return mocks.opencode
    }
  }
}))
vi.mock('./sessions/adapters/echo-adapter', () => ({
  EchoAdapter: class {
    id = 'echo'
    provider = 'echo'
  }
}))
vi.mock('./sessions/chat-model-default', () => ({
  rememberedChatModel: () => undefined,
  rememberedChatEffort: () => undefined
}))
vi.mock('./preferences-manager', () => ({
  preferencesManager: { get: () => undefined, set: () => {} }
}))
vi.mock('./sessions/chat-view-default', () => ({
  initialChatView: (profileDefault: string | undefined) => profileDefault
}))
vi.mock('./sessions/session-manager', () => ({ sessionManager: mocks.manager }))
vi.mock('./title-generator', () => mocks.title)
vi.mock('./launch-profile-manager', () => ({
  defaultViewFor: () => 'clave.chat-view/chat',
  eventsProfile: (id?: string) =>
    id === 'claude-chat' || id === 'codex-chat' || id === 'opencode-chat'
      ? { id, adapterId: id }
      : id?.startsWith('chat:opencode:')
        ? { id, adapterId: 'opencode-chat', sourceProfileId: id.slice('chat:opencode:'.length) }
        : undefined,
  isEchoLaunchProfile: () => false,
  launchProfileManager: {
    resolve: (family: string, _workspaceId?: string, profileId?: string) => ({
      id: profileId ?? `builtin-${family}`,
      family,
      command: family === 'opencode' ? mocks.opencodeCommand : [family],
      additionalArgs: family === 'opencode' ? ['--auto'] : []
    })
  }
}))

import { ptyManager } from './pty-manager'

/** The adapters the facade registered at import, before any test clears the mocks. */
const registeredAtImport = mocks.manager.registerAdapter.mock.calls.map((call) => call[0])

const OPENCODE_SESSION = 'ses_0123456789abcdefABCDEF'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handles.clear()
  mocks.opencodeCommand = ['opencode']
  mocks.backend.getSessionRecord.mockImplementation(() => null)
  mocks.manager.getAdapter.mockImplementation(((id: string) =>
    id === 'opencode-chat'
      ? mocks.opencode
      : id === 'codex-chat'
        ? mocks.codex
        : mocks.claude) as never)
  mocks.manager.subscribe.mockImplementation((id: string, listener: (stream: unknown) => void) => {
    mocks.streams.set(id, listener)
    return () => mocks.streams.delete(id)
  })
})

/** An OpenCode chat as the launcher opens it. */
async function openOpencodeChat(
  extra: Record<string, unknown> = {}
): Promise<Awaited<ReturnType<typeof ptyManager.spawn>>> {
  return ptyManager.spawn('/project', {
    launchProfileId: 'opencode-chat',
    claudeMode: false,
    opencodeMode: true,
    ...extra
  })
}

function spawnOptions(): Record<string, unknown> {
  const call = mocks.opencode.spawn.mock.calls.at(-1) as unknown as [
    { options: Record<string, unknown> }
  ]
  return call[0].options
}

function writtenRecord(): Record<string, unknown> {
  return mocks.backend.writeEventSessionRecord.mock.calls.at(-1)![0]
}

describe('the OpenCode chat adapter is registered (lane D, PRDCT-4427)', () => {
  it('as an ACP adapter named opencode-chat, provider opencode, in the registry', () => {
    expect(mocks.acpSpecs).toContainEqual({
      id: 'opencode-chat',
      provider: 'opencode',
      label: 'OpenCode'
    })
    expect(registeredAtImport).toContain(mocks.opencode)
  })
})

describe('an OpenCode chat spawn (lane D, PRDCT-4427)', () => {
  it('configures the adapter with the binary and acp alone, on the login shell env, the prompt through configure', async () => {
    const session = await openOpencodeChat({ initialPrompt: 'start here' })
    expect(mocks.opencode.configure).toHaveBeenCalledWith(session.id, {
      command: ['opencode', 'acp'],
      env: { PATH: '/login/bin', LOGIN_SHELL: 'yes', TERM: 'xterm-256color' },
      initialPrompt: 'start here'
    })
    // No account of any kind reaches the agent's environment.
    expect(mocks.buildSpawnEnv).toHaveBeenLastCalledWith(
      { PATH: '/login/bin', LOGIN_SHELL: 'yes' },
      {}
    )
    expect(spawnOptions().initialPrompt).toBeUndefined()
  })
  it("runs the saved profile's binary, never its TUI arguments", async () => {
    mocks.opencodeCommand = ['/opt/opencode/bin/opencode']
    const session = await openOpencodeChat({ launchProfileId: 'chat:opencode:mine' })
    expect(mocks.opencode.configure.mock.calls.at(-1)?.[0]).toBe(session.id)
    expect(
      (mocks.opencode.configure.mock.calls.at(-1)?.[1] as { command: string[] }).command
    ).toEqual(['/opt/opencode/bin/opencode', 'acp'])
  })
  it('writes the record with adapterId opencode-chat, opencodeMode, and no account fields', async () => {
    const session = await openOpencodeChat({
      configDir: '/claude/config',
      claudeProfileId: 'work',
      claudeProfileLabel: 'Work',
      codexAccountId: 'acct',
      codexAccountLabel: 'Acct'
    })
    const record = writtenRecord()
    expect(record).toMatchObject({
      id: session.id,
      adapterId: 'opencode-chat',
      transport: 'events',
      opencodeMode: true,
      claudeMode: false,
      codexMode: false,
      launchProfileId: 'opencode-chat'
    })
    for (const key of [
      'configDir',
      'claudeProfileId',
      'claudeProfileLabel',
      'codexAccountId',
      'codexAccountLabel',
      'claudeSessionId',
      'codexThreadId',
      'opencodeSessionId'
    ])
      expect(record[key], key).toBeUndefined()
  })
  it('keeps the session id of its session_meta on the record, and conversationIdOf answers it', async () => {
    const session = await openOpencodeChat()
    ptyManager.attachListeners(
      session.id,
      () => undefined,
      () => undefined
    )
    mocks.streams.get(session.id)?.({
      kind: 'event',
      event: { type: 'session_meta', model: 'stand-in/one', providerSessionId: OPENCODE_SESSION }
    })
    expect(mocks.backend.setSessionOpencodeSessionId).toHaveBeenCalledWith(
      session.id,
      OPENCODE_SESSION
    )
    expect(mocks.backend.setSessionCodexThreadId).not.toHaveBeenCalled()
    expect(ptyManager.conversationIdOf(session.id)).toBe(OPENCODE_SESSION)
  })
  it('passes autoApprove on a launch that skips the permissions, and only then', async () => {
    await openOpencodeChat({ dangerousMode: true })
    expect(spawnOptions().autoApprove).toBe(true)
    expect(spawnOptions().permissionMode).toBeUndefined()
    await openOpencodeChat()
    expect(spawnOptions().autoApprove).toBeUndefined()
  })
  it('passes a resumed id as given (no transcript guard) and records it', async () => {
    await openOpencodeChat({ resumeSessionId: OPENCODE_SESSION })
    expect(spawnOptions().resume).toBe(OPENCODE_SESSION)
    expect(writtenRecord().opencodeSessionId).toBe(OPENCODE_SESSION)
    expect(mocks.title.scheduleChatTitle).not.toHaveBeenCalled()
  })
  it('a Claude and a Codex chat keep their own guards and never get autoApprove', async () => {
    await ptyManager.spawn('/project', {
      launchProfileId: 'codex-chat',
      claudeMode: false,
      codexMode: true,
      resumeSessionId: 'thr-gone',
      dangerousMode: true
    })
    const call = mocks.codex.spawn.mock.calls.at(-1) as unknown as [
      { options: Record<string, unknown> }
    ]
    expect(call[0].options.resume).toBeUndefined()
    expect(call[0].options.autoApprove).toBeUndefined()
    expect(writtenRecord()).toMatchObject({
      codexMode: true,
      claudeMode: false,
      opencodeMode: false
    })
  })
})

describe('an OpenCode chat to its terminal (lane D, PRDCT-4427)', () => {
  it('plans opencodeMode with the OpenCode session resumed and no profile named', async () => {
    const session = await openOpencodeChat()
    ptyManager.attachListeners(
      session.id,
      () => undefined,
      () => undefined
    )
    mocks.streams.get(session.id)?.({
      kind: 'event',
      event: { type: 'session_meta', providerSessionId: OPENCODE_SESSION }
    })
    mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
      key === session.id ? { id: session.id, adapterId: 'opencode-chat' } : null) as never)
    const plan = ptyManager.restartSpawn(session.id, { adapterId: 'pty' })
    expect(plan).toMatchObject({ resumed: true, keepView: false })
    expect(plan?.options).toMatchObject({
      opencodeMode: true,
      resumeSessionId: OPENCODE_SESSION,
      adoptSessionId: session.id
    })
    expect(plan?.options.launchProfileId).toBeUndefined()
    expect(plan?.options.viewId).toBeUndefined()
    expect(plan?.options.claudeSessionId).toBeUndefined()
  })
  // Verifier round 1, Major 1: the chat's map entry goes with the chat's kill;
  // the terminal's Resume still has the OpenCode session to resume.
  it("the terminal's Resume plans the same OpenCode session, from its spawn, else its record", async () => {
    const session = await openOpencodeChat()
    ptyManager.attachListeners(
      session.id,
      () => undefined,
      () => undefined
    )
    mocks.streams.get(session.id)?.({
      kind: 'event',
      event: { type: 'session_meta', providerSessionId: OPENCODE_SESSION }
    })
    mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
      key === session.id ? { id: session.id, adapterId: 'opencode-chat' } : null) as never)
    const plan = ptyManager.restartSpawn(session.id, { adapterId: 'pty' })!
    // The restart: the chat killed for good, the terminal spawned on the plan.
    await ptyManager.kill(session.id, true)
    const terminal = {
      id: session.id,
      cwd: '/project',
      folderName: 'project',
      alive: true,
      ptyProcess: null
    }
    vi.mocked(mocks.pty.prepare).mockImplementation((() => terminal) as never)
    mocks.backend.getSession.mockImplementation(((key: string) =>
      key === session.id ? terminal : undefined) as never)
    await ptyManager.spawn(plan.cwd, plan.options)
    mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
      key === session.id
        ? {
            id: session.id,
            adapterId: 'pty',
            opencodeMode: true,
            opencodeSessionId: OPENCODE_SESSION
          }
        : null) as never)
    expect(ptyManager.conversationIdOf(session.id)).toBe(OPENCODE_SESSION)
    const resume = ptyManager.restartSpawn(session.id, { onlyIfStopped: true })
    expect(resume?.options).toMatchObject({ opencodeMode: true, resumeSessionId: OPENCODE_SESSION })
    expect(resume?.resumed).toBe(true)
    // A terminal spawned with no id of its own: the record's.
    await ptyManager.kill(session.id, true)
    await ptyManager.spawn('/project', { claudeMode: false, opencodeMode: true })
    expect(
      ptyManager.restartSpawn(session.id, { onlyIfStopped: true })?.options.resumeSessionId
    ).toBe(OPENCODE_SESSION)
  })
})

describe('an OpenCode chat on a stored connection (PRDCT-4496 with PRDCT-4427)', () => {
  const STAND_IN_CONFIG = '{"model":"stand-in/one"}'
  const STAND_IN_KEY = 'stand-in-key-not-a-secret'
  it("opens the connection for the ACP agent's environment, and records its name alone", async () => {
    injection.forSpawn.mockResolvedValueOnce({
      providerEnv: { STAND_IN_API_KEY: STAND_IN_KEY, OPENCODE_CONFIG_CONTENT: STAND_IN_CONFIG }
    })
    await openOpencodeChat({
      connectionId: 'conn-1',
      connectionLabel: 'Stand-in',
      model: 'stand-in/one'
    })
    expect(injection.forSpawn).toHaveBeenCalledWith('opencode', {
      connectionId: 'conn-1',
      model: 'stand-in/one'
    })
    expect(mocks.buildSpawnEnv).toHaveBeenLastCalledWith(
      { PATH: '/login/bin', LOGIN_SHELL: 'yes' },
      { providerEnv: { STAND_IN_API_KEY: STAND_IN_KEY, OPENCODE_CONFIG_CONTENT: STAND_IN_CONFIG } }
    )
    // The protocol's command line is unchanged: `--standalone` is the TUI's.
    expect(
      (mocks.opencode.configure.mock.calls.at(-1)?.[1] as { command: string[] }).command
    ).toEqual(['opencode', 'acp'])
    const record = writtenRecord()
    expect(record).toMatchObject({ connectionId: 'conn-1', connectionLabel: 'Stand-in' })
    expect(JSON.stringify(record)).not.toContain(STAND_IN_KEY)
    expect(JSON.stringify(record)).not.toContain('providerEnv')
  })
  // Lane D's note, point 4: the launcher names the bare model (`k3`); the
  // configuration names it `kimi-code-plan-global/k3`, the form OpenCode
  // lists and opens the session on. The adapter must be handed that form, or
  // it asks for `k3`, finds it nowhere and posts a notice.
  it("hands the adapter the configuration's provider/model, the record keeping the launch's own", async () => {
    injection.forSpawn.mockResolvedValueOnce({
      providerEnv: {
        KIMI_API_KEY: STAND_IN_KEY,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          providers: { 'kimi-code-plan-global': { settings: { apiKey: '{env:KIMI_API_KEY}' } } },
          enabled_providers: ['kimi-code-plan-global'],
          model: 'kimi-code-plan-global/k3'
        })
      }
    })
    await openOpencodeChat({ connectionId: 'conn-1', connectionLabel: 'Kimi', model: 'k3' })
    expect(injection.forSpawn).toHaveBeenCalledWith('opencode', {
      connectionId: 'conn-1',
      model: 'k3'
    })
    expect(spawnOptions().model).toBe('kimi-code-plan-global/k3')
    expect(writtenRecord().model).toBe('k3')
    expect(JSON.stringify(mocks.opencode.spawn.mock.calls)).not.toContain(STAND_IN_KEY)
    expect(JSON.stringify(mocks.manager.adopt.mock.calls)).not.toContain(STAND_IN_KEY)
  })
  it("a restart after the agent reported its model opens the connection on that model's own form", async () => {
    injection.forSpawn.mockResolvedValue({ providerEnv: { KIMI_API_KEY: STAND_IN_KEY } })
    const session = await openOpencodeChat({ connectionId: 'conn-1', model: 'k3' })
    ptyManager.attachListeners(
      session.id,
      () => undefined,
      () => undefined
    )
    mocks.streams.get(session.id)?.({
      kind: 'event',
      event: { type: 'session_meta', model: 'kimi-code-plan-global/k3' }
    })
    expect(mocks.backend.setSessionRuntime).toHaveBeenCalledWith(session.id, {
      model: 'kimi-code-plan-global/k3'
    })
    mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
      key === session.id
        ? { id: session.id, adapterId: 'opencode-chat', model: 'kimi-code-plan-global/k3' }
        : null) as never)
    const plan = ptyManager.restartSpawn(session.id, { onlyIfStopped: true })
    await ptyManager.kill(session.id, true)
    await ptyManager.spawn(plan!.cwd, plan!.options)
    // providerInjection keeps a model already in that form (its own tests).
    expect(injection.forSpawn).toHaveBeenLastCalledWith('opencode', {
      connectionId: 'conn-1',
      model: 'kimi-code-plan-global/k3'
    })
    injection.forSpawn.mockReset()
    injection.forSpawn.mockImplementation(async () => ({}))
  })
  it('a chat on no connection hands the adapter the launch’s model as it is', async () => {
    await openOpencodeChat({ model: 'stand-in/two' })
    expect(spawnOptions().model).toBe('stand-in/two')
  })
  it('refuses the spawn when the connection has no key yet, in that one sentence', async () => {
    injection.forSpawn.mockRejectedValueOnce(new Error('The connection has no key yet.'))
    await expect(openOpencodeChat({ connectionId: 'conn-1' })).rejects.toThrow(
      /^The connection has no key yet\.$/
    )
    expect(mocks.opencode.configure).not.toHaveBeenCalled()
    expect(mocks.opencode.spawn).not.toHaveBeenCalled()
    expect(mocks.backend.writeEventSessionRecord).not.toHaveBeenCalled()
  })
  it('opens nothing for a chat on no connection', async () => {
    await openOpencodeChat({ model: 'stand-in/one' })
    expect(injection.forSpawn).not.toHaveBeenCalled()
    expect(writtenRecord().connectionId).toBeUndefined()
  })
  it('refuses the spawn when the connection is gone, before any adapter starts', async () => {
    injection.forSpawn.mockRejectedValueOnce(
      new Error('The selected connection is no longer available.')
    )
    await expect(openOpencodeChat({ connectionId: 'gone' })).rejects.toThrow(
      'The selected connection is no longer available.'
    )
    expect(mocks.opencode.configure).not.toHaveBeenCalled()
    expect(mocks.opencode.spawn).not.toHaveBeenCalled()
  })
  it('a move to the terminal keeps the connection on the plan', async () => {
    injection.forSpawn.mockResolvedValueOnce({ providerEnv: { STAND_IN_API_KEY: STAND_IN_KEY } })
    const session = await openOpencodeChat({ connectionId: 'conn-1', connectionLabel: 'Stand-in' })
    mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
      key === session.id ? { id: session.id, adapterId: 'opencode-chat' } : null) as never)
    const plan = ptyManager.restartSpawn(session.id, { adapterId: 'pty' })
    expect(plan?.options).toMatchObject({
      opencodeMode: true,
      connectionId: 'conn-1',
      connectionLabel: 'Stand-in'
    })
    expect(JSON.stringify(plan?.options)).not.toContain(STAND_IN_KEY)
  })
})
