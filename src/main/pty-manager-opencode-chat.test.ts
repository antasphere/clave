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
})
