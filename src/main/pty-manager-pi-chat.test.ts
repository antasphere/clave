import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { piSessionDir } from './session-history/pi'

// Lane D (PRDCT-4427): Pi opens in Clave's chat views through the Pi rpc
// adapter. These pin the facade's half: the spawn configures the adapter
// with Pi's own command line (`buildAgentArgv`) in rpc mode on the login
// shell's environment, under a session id of Clave's own (`--session-id`),
// resumed (`--session`) only when Pi wrote the session's file; the tab's
// record carries that id, and the restart onto the terminal and back keeps
// it.

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
      getSession: vi.fn<(id: string) => unknown>(() => undefined),
      getAllSessions: vi.fn(() => [])
    },
    /** The login shell's environment, Pi's home in it when a test sets one. */
    loginEnv: { PATH: '/login/bin', LOGIN_SHELL: 'yes' } as Record<string, string>,
    buildSpawnEnv: vi.fn<
      (base: Record<string, string>, account: Record<string, unknown>) => Record<string, string>
    >((base) => ({ ...base, TERM: 'xterm-256color' })),
    pty: {
      id: 'pty',
      provider: 'terminal',
      prepare: vi.fn<(cwd: string, options: Record<string, unknown>) => unknown>(),
      detach: vi.fn()
    },
    claude: {
      id: 'claude-chat',
      provider: 'claude',
      configure: vi.fn(),
      spawn: vi.fn(async (spec: { id: string }) => ({ id: spec.id })),
      kill: vi.fn(async () => undefined)
    },
    pi: {
      id: 'pi-chat',
      provider: 'pi',
      configure: vi.fn(),
      spawn: vi.fn(async (spec: { id: string }) => ({ id: spec.id })),
      kill: vi.fn(async () => undefined)
    },
    piSpecs: [] as unknown[],
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
  getLoginShellEnv: () => ({ ...mocks.loginEnv })
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
vi.mock('./provider-injection-spawn', () => ({ providerInjectionForSpawn: injection.forSpawn }))
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
  findTranscript: () => null
}))
vi.mock('./sessions/adapters/codex-adapter', () => ({
  CodexAdapter: class {
    id = 'codex-chat'
    provider = 'codex'
  }
}))
vi.mock('./sessions/adapters/acp-adapter', () => ({
  AcpAdapter: class {
    id = 'opencode-chat'
    provider = 'opencode'
  }
}))
vi.mock('./sessions/adapters/pi-rpc-adapter', () => ({
  PiRpcAdapter: class {
    constructor(spec: unknown) {
      mocks.piSpecs.push(spec)
      return mocks.pi
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
    id === 'claude-chat' || id === 'pi-chat' ? { id, adapterId: id } : undefined,
  isEchoLaunchProfile: () => false,
  launchProfileManager: {
    resolve: (family: string, _workspaceId?: string, profileId?: string) => ({
      id: profileId ?? `builtin-${family}`,
      family,
      command: [family],
      additionalArgs: []
    })
  }
}))

import { ptyManager } from './pty-manager'

/** The adapters the facade registered at import, before any test clears the mocks. */
const registeredAtImport = mocks.manager.registerAdapter.mock.calls.map((call) => call[0])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PI_SESSION = '0198c7d2-1111-7222-8333-444455556666'
let piHome: string

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handles.clear()
  piHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-pi-chat-'))
  mocks.loginEnv = { PATH: '/login/bin', LOGIN_SHELL: 'yes', PI_CODING_AGENT_DIR: piHome }
  mocks.backend.getSessionRecord.mockImplementation(() => null)
  mocks.backend.getSession.mockImplementation(() => undefined)
  mocks.manager.getAdapter.mockImplementation(((id: string) =>
    id === 'pi-chat' ? mocks.pi : mocks.claude) as never)
})
afterEach(() => {
  fs.rmSync(piHome, { recursive: true, force: true })
})

/** The session file Pi writes at a session's first message. */
function writePiSession(id: string, cwd = '/project'): void {
  const dir = piSessionDir(cwd, { PI_CODING_AGENT_DIR: piHome })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `2026-11-13T14-21-16-666Z_${id}.jsonl`), '{"type":"session"}\n')
}

/** A Pi chat as the launcher opens it. */
async function openPiChat(
  extra: Record<string, unknown> = {}
): Promise<Awaited<ReturnType<typeof ptyManager.spawn>>> {
  return ptyManager.spawn('/project', {
    launchProfileId: 'pi-chat',
    claudeMode: false,
    piMode: true,
    ...extra
  })
}

function configured(): { command: string[]; env: Record<string, string>; initialPrompt?: string } {
  return mocks.pi.configure.mock.calls.at(-1)![1] as never
}
function spawnOptions(): Record<string, unknown> {
  const call = mocks.pi.spawn.mock.calls.at(-1) as unknown as [{ options: Record<string, unknown> }]
  return call[0].options
}
function writtenRecord(): Record<string, unknown> {
  return mocks.backend.writeEventSessionRecord.mock.calls.at(-1)![0]
}
const after = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]

describe('the Pi chat adapter is registered (lane D, PRDCT-4427)', () => {
  it('as a Pi rpc adapter named pi-chat, provider pi, in the registry', () => {
    expect(mocks.piSpecs).toContainEqual({ id: 'pi-chat', provider: 'pi', label: 'Pi' })
    expect(registeredAtImport).toContain(mocks.pi)
  })
})

describe('a Pi chat spawn (lane D, PRDCT-4427)', () => {
  it("configures Pi's command line in rpc mode under a fresh id of Clave's, on the login shell env", async () => {
    const session = await openPiChat({ initialPrompt: 'start here' })
    expect(mocks.pi.configure.mock.calls.at(-1)?.[0]).toBe(session.id)
    const { command, env, initialPrompt } = configured()
    expect(command[0]).toBe('pi')
    expect(command.slice(-2)).toEqual(['--mode', 'rpc'])
    const id = after(command, '--session-id')
    expect(id).toMatch(UUID_RE)
    expect(command).not.toContain('--session')
    // The state extension is the terminal's; the prompt goes over rpc.
    expect(command).not.toContain('--extension')
    expect(command).not.toContain('start here')
    expect(initialPrompt).toBe('start here')
    expect(env).toEqual({ ...mocks.loginEnv, TERM: 'xterm-256color' })
    expect(mocks.buildSpawnEnv).toHaveBeenLastCalledWith(mocks.loginEnv, {})
    expect(spawnOptions().resume).toBeUndefined()
    expect(session.piSessionId).toBe(id)
  })
  it('writes the record with adapterId pi-chat, piMode and its session id, and no account', async () => {
    const session = await openPiChat({
      piProvider: 'anthropic',
      piThinking: 'high',
      configDir: '/claude/config',
      claudeProfileId: 'work',
      codexAccountId: 'acct'
    })
    const id = after(configured().command, '--session-id')
    const record = writtenRecord()
    expect(record).toMatchObject({
      id: session.id,
      adapterId: 'pi-chat',
      transport: 'events',
      piMode: true,
      piSessionId: id,
      piProvider: 'anthropic',
      piThinking: 'high',
      claudeMode: false,
      codexMode: false,
      opencodeMode: false,
      launchProfileId: 'pi-chat'
    })
    for (const key of [
      'configDir',
      'claudeProfileId',
      'codexAccountId',
      'claudeSessionId',
      'codexThreadId',
      'opencodeSessionId'
    ])
      expect(record[key], key).toBeUndefined()
    expect(ptyManager.conversationIdOf(session.id)).toBe(id)
  })
  it("resumes with --session when Pi wrote the session's file", async () => {
    writePiSession(PI_SESSION)
    const session = await openPiChat({ resumeSessionId: PI_SESSION })
    const { command } = configured()
    expect(after(command, '--session')).toBe(PI_SESSION)
    expect(command).not.toContain('--session-id')
    expect(spawnOptions().resume).toBe(PI_SESSION)
    expect(writtenRecord().piSessionId).toBe(PI_SESSION)
    expect(session.piSessionId).toBe(PI_SESSION)
    expect(mocks.title.scheduleChatTitle).not.toHaveBeenCalled()
  })
  it('starts fresh under the same id when the file is missing', async () => {
    writePiSession(PI_SESSION, '/another/project')
    await openPiChat({ resumeSessionId: PI_SESSION })
    const { command } = configured()
    expect(after(command, '--session-id')).toBe(PI_SESSION)
    expect(command).not.toContain('--session')
    expect(spawnOptions().resume).toBeUndefined()
    expect(writtenRecord().piSessionId).toBe(PI_SESSION)
  })
  it('passes the launch’s model, provider and thinking on the command line and the model to the adapter', async () => {
    await openPiChat({ model: 'sonnet', piProvider: 'anthropic', piThinking: 'low' })
    const { command } = configured()
    expect(after(command, '--model')).toBe('sonnet')
    expect(after(command, '--provider')).toBe('anthropic')
    expect(after(command, '--thinking')).toBe('low')
    expect(spawnOptions().model).toBe('sonnet')
  })
})

describe('a Pi chat on a stored connection (PRDCT-4496 with PRDCT-4427)', () => {
  const STAND_IN_KEY = 'stand-in-key-not-a-secret'
  it("opens the connection: its variables on Pi's environment, its provider on the command line, its name on the record", async () => {
    injection.forSpawn.mockResolvedValueOnce({
      providerEnv: { STAND_IN_API_KEY: STAND_IN_KEY, PI_CODING_AGENT_DIR: '/stand-in/pi-dir' },
      piProvider: 'stand-in-provider'
    })
    await openPiChat({
      connectionId: 'conn-1',
      connectionLabel: 'Stand-in',
      model: 'stand-in-model',
      piProvider: 'anthropic'
    })
    expect(injection.forSpawn).toHaveBeenCalledWith('pi', {
      connectionId: 'conn-1',
      model: 'stand-in-model'
    })
    expect(mocks.buildSpawnEnv).toHaveBeenLastCalledWith(mocks.loginEnv, {
      providerEnv: { STAND_IN_API_KEY: STAND_IN_KEY, PI_CODING_AGENT_DIR: '/stand-in/pi-dir' }
    })
    const { command } = configured()
    // The connection's provider wins over a remembered one, as on the terminal.
    expect(after(command, '--provider')).toBe('stand-in-provider')
    expect(after(command, '--model')).toBe('stand-in-model')
    expect(command).not.toContain(STAND_IN_KEY)
    const record = writtenRecord()
    expect(record).toMatchObject({ connectionId: 'conn-1', connectionLabel: 'Stand-in' })
    expect(JSON.stringify(record)).not.toContain(STAND_IN_KEY)
  })
  it('opens nothing for a chat on no connection, the remembered provider kept', async () => {
    await openPiChat({ piProvider: 'anthropic' })
    expect(injection.forSpawn).not.toHaveBeenCalled()
    expect(after(configured().command, '--provider')).toBe('anthropic')
    expect(mocks.buildSpawnEnv).toHaveBeenLastCalledWith(mocks.loginEnv, {})
    expect(writtenRecord().connectionId).toBeUndefined()
  })
})

describe('a Pi chat to its terminal and back (lane D, PRDCT-4427)', () => {
  // Verifier round 1, Major 2: Pi writes its session file at the first
  // message; `--session <id>` on a session with no file exits 1.
  it('plans piMode under the same Pi session id (--session-id) when Pi wrote no file yet, no profile named', async () => {
    const session = await openPiChat()
    const id = after(configured().command, '--session-id')
    mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
      key === session.id ? { id: session.id, adapterId: 'pi-chat' } : null) as never)
    const plan = ptyManager.restartSpawn(session.id, { adapterId: 'pty' })
    expect(plan).toMatchObject({ keepView: false })
    expect(plan?.options).toMatchObject({
      piMode: true,
      piSessionId: id,
      adoptSessionId: session.id
    })
    expect(plan?.options.resumeSessionId).toBeUndefined()
    // The terminal profile is the family's selected one, resolved by the spawn.
    expect(plan?.options.launchProfileId).toBeUndefined()
    expect(plan?.options.viewId).toBeUndefined()
  })
  it('plans piMode with the Pi session resumed (--session) once Pi wrote its file', async () => {
    const session = await openPiChat()
    const id = after(configured().command, '--session-id')!
    writePiSession(id)
    mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
      key === session.id ? { id: session.id, adapterId: 'pi-chat' } : null) as never)
    const plan = ptyManager.restartSpawn(session.id, { adapterId: 'pty' })
    expect(plan).toMatchObject({ resumed: true, keepView: false })
    expect(plan?.options).toMatchObject({ piMode: true, resumeSessionId: id })
    expect(plan?.options.piSessionId).toBeUndefined()
  })
  it("a Pi terminal's session goes into the chat on the same id", async () => {
    mocks.pty.prepare.mockImplementation(((cwd: string) => ({
      id: 'pi-term',
      cwd,
      folderName: 'project',
      alive: true,
      ptyProcess: null,
      piSessionId: PI_SESSION
    })) as never)
    const terminal = await ptyManager.spawn('/project', { claudeMode: false, piMode: true })
    mocks.backend.getSession.mockImplementation(((key: string) =>
      key === terminal.id ? terminal : undefined) as never)
    mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
      key === terminal.id ? { id: terminal.id, adapterId: 'pty' } : null) as never)
    expect(ptyManager.conversationIdOf(terminal.id)).toBe(PI_SESSION)
    const plan = ptyManager.restartSpawn(terminal.id, {
      adapterId: 'pi-chat',
      viewId: 'clave.chat-view/chat'
    })
    expect(plan?.options).toMatchObject({
      piMode: true,
      launchProfileId: 'pi-chat',
      resumeSessionId: PI_SESSION,
      viewId: 'clave.chat-view/chat',
      adoptSessionId: terminal.id
    })
  })
})
