import { beforeEach, describe, expect, it, vi } from 'vitest'

// Antigravity opens in Clave's chat views through the ACP adapter (`agy acp`).
// These pin the facade's half: the spawn configures the adapter with the
// binary and `acp` alone on the login shell's environment, writes the tab's
// record with Antigravity's own fields and no account, hands the rung of its
// ladder to the session as its mode, keeps the conversation the agent opened,
// and a restart onto the terminal resumes it (`agy --conversation <id>`).

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
      setSessionAntigravitySessionId: vi.fn(),
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
    antigravity: {
      id: 'antigravity-chat',
      provider: 'antigravity',
      configure: vi.fn(),
      chosenMode: vi.fn<(id: string) => string | undefined>(() => undefined),
      spawn: vi.fn(async (spec: { id: string }) => ({ id: spec.id })),
      kill: vi.fn(async () => undefined)
    },
    acpSpecs: [] as unknown[],
    preferences: {} as Record<string, unknown>,
    /** The command the resolved Antigravity profile runs, when a test sets one. */
    agyCommand: ['agy'] as string[],
    /** The resolved Antigravity profile's own arguments. */
    agyArgs: ['--sandbox'] as string[],
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
    constructor(spec: { id: string }) {
      mocks.acpSpecs.push(spec)
      return spec.id === 'antigravity-chat' ? mocks.antigravity : mocks.opencode
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
  preferencesManager: { get: (key: string) => mocks.preferences[key], set: () => {} }
}))
vi.mock('./sessions/chat-view-default', () => ({
  initialChatView: (profileDefault: string | undefined) => profileDefault
}))
vi.mock('./sessions/session-manager', () => ({ sessionManager: mocks.manager }))
// PRDCT-4551: the ledger of starts, recorded.
const ledger = vi.hoisted(() => ({ recordHarnessStart: vi.fn() }))
vi.mock('./usage-ledger', () => ledger)
vi.mock('./title-generator', () => mocks.title)
const cli = vi.hoisted(() => ({
  readAntigravityStartMode: vi.fn(() => 'auto'),
  readProfileSettings: vi.fn<(settings: string | undefined) => Record<string, unknown>>(() => ({})),
  settingsFileThatAsks: vi.fn<(file: string) => string | undefined>(() => '/private/ask.json')
}))
// The server of `npm run dev:attached`: no app folder, its own preferences.
const attached = vi.hoisted(() => ({ served: false }))
vi.mock('./antigravity-setting', () => ({
  personAntigravityRung: (sent?: string) =>
    (mocks.preferences.harnessSettings as { antigravity?: { permissionDefault?: string } })
      ?.antigravity?.permissionDefault ?? (attached.served ? sent : undefined)
}))
vi.mock('./antigravity-cli', () => cli)
vi.mock('./launch-profile-manager', () => ({
  defaultViewFor: () => 'clave.chat-view/chat',
  eventsProfile: (id?: string) =>
    id === 'claude-chat' || id === 'codex-chat' || id === 'antigravity-chat'
      ? { id, adapterId: id }
      : id?.startsWith('chat:antigravity:')
        ? {
            id,
            adapterId: 'antigravity-chat',
            sourceProfileId: id.slice('chat:antigravity:'.length)
          }
        : undefined,
  isEchoLaunchProfile: () => false,
  launchProfileManager: {
    resolve: (family: string, _workspaceId?: string, profileId?: string) => ({
      id: profileId ?? `builtin-${family}`,
      family,
      command: family === 'antigravity' ? mocks.agyCommand : [family],
      additionalArgs: family === 'antigravity' ? mocks.agyArgs : []
    })
  }
}))

import { ptyManager } from './pty-manager'
import { transportSwitchOptions } from './sessions/provider-switch'

/** The adapters the facade registered at import, before any test clears the mocks. */
const registeredAtImport = mocks.manager.registerAdapter.mock.calls.map((call) => call[0])

const CONVERSATION = '70ec1049-f3e9-46a9-bd24-382267964044'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handles.clear()
  mocks.agyCommand = ['agy']
  mocks.agyArgs = ['--sandbox']
  mocks.preferences = {}
  mocks.backend.getSessionRecord.mockImplementation(() => null)
  mocks.manager.getAdapter.mockImplementation(((id: string) =>
    id === 'antigravity-chat'
      ? mocks.antigravity
      : id === 'codex-chat'
        ? mocks.codex
        : mocks.claude) as never)
  mocks.manager.subscribe.mockImplementation((id: string, listener: (stream: unknown) => void) => {
    mocks.streams.set(id, listener)
    return () => mocks.streams.delete(id)
  })
})

/** An Antigravity chat as the launcher opens it. */
async function openAntigravityChat(
  extra: Record<string, unknown> = {}
): Promise<Awaited<ReturnType<typeof ptyManager.spawn>>> {
  return ptyManager.spawn('/project', {
    launchProfileId: 'antigravity-chat',
    claudeMode: false,
    antigravityMode: true,
    ...extra
  })
}

function spawnOptions(): Record<string, unknown> {
  const call = mocks.antigravity.spawn.mock.calls.at(-1) as unknown as [
    { options: Record<string, unknown> }
  ]
  return call[0].options
}

function writtenRecord(): Record<string, unknown> {
  return mocks.backend.writeEventSessionRecord.mock.calls.at(-1)![0]
}

function sayConversation(id: string): void {
  ptyManager.attachListeners(
    id,
    () => undefined,
    () => undefined
  )
  mocks.streams.get(id)?.({
    kind: 'event',
    event: { type: 'session_meta', model: 'gemini-4-neon', providerSessionId: CONVERSATION }
  })
}

describe('the Antigravity chat adapter is registered', () => {
  it('as an ACP adapter named antigravity-chat, provider antigravity, in the registry', () => {
    expect(mocks.acpSpecs).toContainEqual({
      id: 'antigravity-chat',
      provider: 'antigravity',
      label: 'Antigravity',
      sessionOptions: true
    })
    expect(registeredAtImport).toContain(mocks.antigravity)
  })
})

describe('an Antigravity chat spawn', () => {
  it('configures the adapter with the binary and acp alone, on the login shell env, the prompt through configure', async () => {
    const session = await openAntigravityChat({ initialPrompt: 'start here' })
    expect(mocks.antigravity.configure).toHaveBeenCalledWith(session.id, {
      command: ['agy', 'acp'],
      env: { PATH: '/login/bin', LOGIN_SHELL: 'yes', TERM: 'xterm-256color' },
      initialPrompt: 'start here'
    })
    expect(mocks.buildSpawnEnv).toHaveBeenLastCalledWith(
      { PATH: '/login/bin', LOGIN_SHELL: 'yes' },
      {}
    )
    expect(mocks.opencode.configure).not.toHaveBeenCalled()
  })
  it("runs the saved profile's binary, never its TUI arguments", async () => {
    mocks.agyCommand = ['/opt/agy/bin/agy']
    const session = await openAntigravityChat({ launchProfileId: 'chat:antigravity:mine' })
    expect(mocks.antigravity.configure.mock.calls.at(-1)?.[0]).toBe(session.id)
    expect(
      (mocks.antigravity.configure.mock.calls.at(-1)?.[1] as { command: string[] }).command
    ).toEqual(['/opt/agy/bin/agy', 'acp'])
  })
  it('writes the record with adapterId antigravity-chat, antigravityMode, and no account fields', async () => {
    const session = await openAntigravityChat({
      configDir: '/claude/config',
      claudeProfileId: 'work',
      claudeProfileLabel: 'Work',
      codexAccountId: 'acct',
      codexAccountLabel: 'Acct'
    })
    const record = writtenRecord()
    expect(record).toMatchObject({
      id: session.id,
      adapterId: 'antigravity-chat',
      transport: 'events',
      antigravityMode: true,
      claudeMode: false,
      codexMode: false,
      opencodeMode: false,
      launchProfileId: 'antigravity-chat'
    })
    for (const key of [
      'configDir',
      'claudeProfileId',
      'claudeProfileLabel',
      'codexAccountId',
      'codexAccountLabel',
      'claudeSessionId',
      'codexThreadId',
      'opencodeSessionId',
      'antigravitySessionId',
      'connectionId'
    ])
      expect(record[key], key).toBeUndefined()
  })
  it('hands a rung of its ladder to the session as its mode, and nothing else', async () => {
    await openAntigravityChat({ permissionMode: 'plan' })
    expect(spawnOptions().mode).toBe('plan')
    expect(spawnOptions().permissionMode).toBeUndefined()
    // Claude's word for a mode is not Antigravity's: it was still said, so it asks.
    await openAntigravityChat({ permissionMode: 'bypassPermissions' })
    expect(spawnOptions().mode).toBe('default')
    await openAntigravityChat()
    expect(spawnOptions().mode).toBeUndefined()
    expect(spawnOptions().autoApprove).toBeUndefined()
  })
  it("starts a saved profile's chat on the profile's own --mode, as its terminal does", async () => {
    mocks.agyArgs = ['--mode', 'plan']
    mocks.preferences.harnessSettings = { antigravity: { permissionDefault: 'auto' } }
    await openAntigravityChat({ launchProfileId: 'chat:antigravity:mine' })
    expect(spawnOptions().mode).toBe('plan')
    // A rung the launch names still wins over it.
    await openAntigravityChat({ launchProfileId: 'chat:antigravity:mine', permissionMode: 'auto' })
    expect(spawnOptions().mode).toBe('auto')
  })
  it("starts on the person's permission default (Settings → Harnesses)", async () => {
    mocks.preferences.harnessSettings = { antigravity: { permissionDefault: 'accept-edits' } }
    await openAntigravityChat()
    expect(spawnOptions().mode).toBe('accept-edits')
  })
  it("starts on the CLI's own mode, Auto, when nothing names one", async () => {
    await openAntigravityChat()
    expect(spawnOptions().defaultMode).toBe('auto')
    expect(cli.readAntigravityStartMode).toHaveBeenCalledWith(
      expect.objectContaining({ LOGIN_SHELL: 'yes' })
    )
    cli.readAntigravityStartMode.mockReturnValueOnce('plan')
    await openAntigravityChat()
    expect(spawnOptions().defaultMode).toBe('plan')
  })
  it('never reads that default over a mode that was named', async () => {
    await openAntigravityChat({ permissionMode: 'default' })
    expect(spawnOptions()).toMatchObject({ mode: 'default' })
    expect(spawnOptions().defaultMode).toBeUndefined()
    expect(cli.readAntigravityStartMode).not.toHaveBeenCalled()
  })
  it('hands the model and the level to the session', async () => {
    await openAntigravityChat({ model: 'claude-opus-5-5', effort: 'low' })
    expect(spawnOptions()).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
  })
  it('keeps the conversation of its session_meta on the record, and conversationIdOf answers it', async () => {
    const session = await openAntigravityChat()
    sayConversation(session.id)
    expect(mocks.backend.setSessionAntigravitySessionId).toHaveBeenCalledWith(
      session.id,
      CONVERSATION
    )
    expect(mocks.backend.setSessionOpencodeSessionId).not.toHaveBeenCalled()
    expect(mocks.backend.setSessionCodexThreadId).not.toHaveBeenCalled()
    expect(ptyManager.conversationIdOf(session.id)).toBe(CONVERSATION)
  })
  it('passes a resumed id as given and records it', async () => {
    await openAntigravityChat({ resumeSessionId: CONVERSATION })
    expect(spawnOptions().resume).toBe(CONVERSATION)
    expect(writtenRecord().antigravitySessionId).toBe(CONVERSATION)
    expect(mocks.title.scheduleChatTitle).not.toHaveBeenCalled()
  })
})

describe('an Antigravity chat to its terminal', () => {
  it('plans antigravityMode with the conversation resumed and no profile named', async () => {
    const session = await openAntigravityChat()
    sayConversation(session.id)
    mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
      key === session.id ? { id: session.id, adapterId: 'antigravity-chat' } : null) as never)
    const plan = ptyManager.restartSpawn(session.id, { adapterId: 'pty' })
    expect(plan).toMatchObject({ resumed: true, keepView: false })
    expect(plan?.options).toMatchObject({
      antigravityMode: true,
      resumeSessionId: CONVERSATION,
      adoptSessionId: session.id
    })
    expect(plan?.options.viewId).toBeUndefined()
    expect(plan?.options.claudeSessionId).toBeUndefined()
  })
  it("the terminal's Resume plans the same conversation, from its spawn, else its record", async () => {
    const session = await openAntigravityChat()
    sayConversation(session.id)
    mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
      key === session.id ? { id: session.id, adapterId: 'antigravity-chat' } : null) as never)
    const plan = ptyManager.restartSpawn(session.id, { adapterId: 'pty' })!
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
    expect(ptyManager.conversationIdOf(session.id)).toBe(CONVERSATION)
    const resume = ptyManager.restartSpawn(session.id, { onlyIfStopped: true })
    expect(resume?.options).toMatchObject({
      antigravityMode: true,
      resumeSessionId: CONVERSATION
    })
    expect(resume?.resumed).toBe(true)
    // A terminal spawned with no id of its own: the record's.
    await ptyManager.kill(session.id, true)
    mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
      key === session.id
        ? {
            id: session.id,
            adapterId: 'pty',
            antigravityMode: true,
            antigravitySessionId: CONVERSATION
          }
        : null) as never)
    await ptyManager.spawn('/project', { claudeMode: false, antigravityMode: true })
    expect(
      ptyManager.restartSpawn(session.id, { onlyIfStopped: true })?.options.resumeSessionId
    ).toBe(CONVERSATION)
  })
})

describe('a mode somebody named never ends looser', () => {
  const setting = (rung: string): void => {
    mocks.preferences.harnessSettings = { antigravity: { permissionDefault: rung } }
  }
  const openTerminal = async (extra: Record<string, unknown> = {}): Promise<void> => {
    vi.mocked(mocks.pty.prepare).mockImplementation((() => ({
      id: 'terminal-1',
      cwd: '/project',
      folderName: 'project',
      alive: true,
      ptyProcess: null
    })) as never)
    await ptyManager.spawn('/project', { claudeMode: false, antigravityMode: true, ...extra })
  }
  const terminalOptions = (): Record<string, unknown> =>
    (vi.mocked(mocks.pty.prepare).mock.calls.at(-1) as unknown as unknown[])[1] as Record<
      string,
      unknown
    >

  it('keeps the setting when the launch skips permissions, which agy’s chat cannot', async () => {
    setting('default')
    await openAntigravityChat({ dangerousMode: true })
    expect(spawnOptions().mode).toBe('default')
  })
  it.each(['acceptEdits', 'dontAsk', 'manual', 'read-only'])(
    'keeps a stricter setting under the foreign mode %s',
    async (permissionMode) => {
      setting('plan')
      await openAntigravityChat({ permissionMode })
      expect(spawnOptions().mode).toBe('plan')
    }
  )
  it.each([['--mode', 'bogus'], ['--mode=Plan']])(
    'asks under a profile’s %s %s',
    async (...args) => {
      mocks.agyArgs = args.filter((arg): arg is string => typeof arg === 'string')
      setting('default')
      await openAntigravityChat()
      expect(spawnOptions().mode).toBe('default')
    }
  )
  it('reads a single-dash profile mode', async () => {
    mocks.agyArgs = ['-mode', 'plan']
    await openAntigravityChat()
    expect(spawnOptions().mode).toBe('plan')
  })
  it('reads what the profile’s --settings says', async () => {
    cli.readProfileSettings.mockReturnValueOnce({ start: 'plan' })
    mocks.agyArgs = ['--settings', '{"agentMode":"plan"}']
    await openAntigravityChat()
    expect(spawnOptions().mode).toBe('plan')
    expect(cli.readProfileSettings.mock.calls.at(-1)?.[0]).toBe('{"agentMode":"plan"}')
  })
  it('asks in a routine’s run', async () => {
    await openAntigravityChat({ link: { kind: 'routine', routineKey: 'k', runId: 'r' } })
    expect(spawnOptions().mode).toBe('default')
  })

  it('never pins a default on the record: each spawn resolves it again', async () => {
    await openAntigravityChat()
    expect(writtenRecord().permissionMode).toBeUndefined()
    setting('plan')
    await openAntigravityChat()
    expect(spawnOptions().mode).toBe('plan')
    expect(writtenRecord().permissionMode).toBeUndefined()
    expect(spawnOptions().pickedMode).toBeUndefined()
  })
  it('records a mode that was named, and hands it as picked', async () => {
    await openAntigravityChat({ permissionMode: 'plan' })
    expect(writtenRecord().permissionMode).toBe('plan')
    expect(spawnOptions().pickedMode).toBe('plan')
  })
  it('writes back the mode picked, never the one the default gave', async () => {
    const session = await openAntigravityChat()
    ptyManager.attachListeners(
      session.id,
      () => undefined,
      () => undefined
    )
    const says = (mode: string): void =>
      mocks.streams.get(session.id)?.({
        kind: 'event',
        event: { type: 'permission_mode', mode, modes: [] }
      })
    says('auto')
    expect(mocks.backend.setSessionRuntime).not.toHaveBeenCalledWith(session.id, {
      permissionMode: 'auto'
    })
    // Nothing picked takes back a step of the agent's own written earlier.
    expect(mocks.backend.setSessionRuntime).toHaveBeenCalledWith(session.id, {
      permissionMode: null
    })
    mocks.antigravity.chosenMode.mockReturnValue('plan')
    says('plan')
    expect(mocks.backend.setSessionRuntime).toHaveBeenCalledWith(session.id, {
      permissionMode: 'plan'
    })
    mocks.antigravity.chosenMode.mockReturnValue(undefined)
  })

  it("takes the record's own mode when the spawn lost it (an older app's adopt)", async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    mocks.backend.getSessionRecord.mockImplementation((() => ({
      id,
      antigravityMode: true,
      permissionMode: 'accept-edits'
    })) as never)
    await openAntigravityChat({ adoptSessionId: id })
    expect(spawnOptions().mode).toBe('accept-edits')
  })
  it('never reads another provider’s recorded mode as this one’s', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    mocks.backend.getSessionRecord.mockImplementation((() => ({
      id,
      antigravityMode: false,
      permissionMode: 'auto'
    })) as never)
    setting('default')
    await openAntigravityChat({ adoptSessionId: id, dangerousMode: true })
    expect(spawnOptions().mode).toBe('default')
  })

  it.each(['plan', 'default', 'accept-edits', 'auto'])(
    'keeps %s from the chat to the terminal and back',
    async (mode) => {
      const session = await openAntigravityChat({ permissionMode: mode })
      sayConversation(session.id)
      mocks.backend.getSessionRecord.mockImplementation((() => ({
        id: session.id,
        adapterId: 'antigravity-chat',
        antigravityMode: true,
        permissionMode: mode
      })) as never)
      const toTerminal = ptyManager.restartSpawn(session.id, { adapterId: 'pty' })!
      expect(toTerminal.options.permissionMode).toBe(mode)
      const back = transportSwitchOptions(
        toTerminal.options,
        { adapterId: 'antigravity-chat', resume: CONVERSATION },
        { profileExists: () => false }
      )
      expect(back.permissionMode).toBe(mode)
    }
  )
  it('takes the level to the terminal', async () => {
    const session = await openAntigravityChat({ effort: 'low' })
    sayConversation(session.id)
    mocks.backend.getSessionRecord.mockImplementation((() => ({
      id: session.id,
      adapterId: 'antigravity-chat',
      antigravityMode: true,
      effort: 'low'
    })) as never)
    expect(ptyManager.restartSpawn(session.id, { adapterId: 'pty' })!.options.effort).toBe('low')
  })
  it('asks in a chat under rules only a terminal can be handed', async () => {
    cli.readProfileSettings.mockReturnValue({ rules: true })
    mocks.agyArgs = ['--settings', '{"permissions":{"deny":["command(rm)"]}}']
    await openAntigravityChat({ permissionMode: 'auto' })
    expect(spawnOptions().mode).toBe('default')
    await openTerminal({ permissionMode: 'auto' })
    expect(terminalOptions().antigravityLaunchMode).toBe('auto')
    cli.readProfileSettings.mockReturnValue({})
  })
  it('hands a terminal a copy of its settings file that asks', async () => {
    mocks.agyArgs = ['--settings', 'rules.json']
    await openTerminal({ permissionMode: 'default' })
    expect(terminalOptions().antigravityAskSettings).toBe('/private/ask.json')
  })
  it('reads the setting a launch carries below the profile, and never as a pick', async () => {
    attached.served = true
    await openAntigravityChat({ permissionDefault: 'plan' })
    expect(spawnOptions().mode).toBe('plan')
    expect(spawnOptions().pickedMode).toBeUndefined()
    expect(writtenRecord().permissionMode).toBeUndefined()
    expect(writtenRecord().permissionDefault).toBe('plan')
    mocks.agyArgs = ['--mode', 'plan']
    await openAntigravityChat({ permissionDefault: 'auto' })
    expect(spawnOptions().mode).toBe('plan')
    attached.served = false
  })
  it('reads a mode marked as the setting as the setting, never a pick', async () => {
    attached.served = true
    const sent = { permissionMode: 'auto', permissionModeFromSetting: true }
    mocks.agyArgs = ['--mode', 'plan']
    await openAntigravityChat(sent)
    expect(spawnOptions().mode).toBe('plan')
    expect(writtenRecord().permissionMode).toBeUndefined()
    mocks.agyArgs = []
    await openAntigravityChat({ ...sent, permissionMode: 'plan' })
    expect(spawnOptions().mode).toBe('plan')
    expect(spawnOptions().pickedMode).toBeUndefined()
    expect(writtenRecord().permissionDefault).toBe('plan')
    attached.served = false
  })
  it('hands a terminal the mode it runs in, apart from the one that was named', async () => {
    setting('default')
    await openTerminal()
    expect(terminalOptions().antigravityLaunchMode).toBe('default')
    expect(terminalOptions().permissionMode).toBeUndefined()
  })
})
