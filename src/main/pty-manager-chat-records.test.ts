import { beforeEach, describe, expect, it, vi } from 'vitest'

// A chat tab has no PTY, so nothing wrote it a session record and it was gone
// at the next launch. These pin the facade's half of the fix: the record is
// written at spawn, dropped on a real close, kept on quit, and a restore
// resumes the conversation under the tab's own id.

const mocks = vi.hoisted(() => {
  const handles = new Map<string, { id: string }>()
  return {
    handles,
    backend: {
      writeEventSessionRecord: vi.fn(() => true),
      discardSessionRecord: vi.fn(),
      setSessionViewRecord: vi.fn(),
      setSessionWorkspace: vi.fn(),
      setSessionClaudeSessionId: vi.fn(),
      setSessionCodexThreadId: vi.fn(),
      getSessionRecord: vi.fn(() => null),
      tmuxNameOf: vi.fn(() => null),
      waitForTmuxSessionGone: vi.fn(async () => undefined),
      listAdoptableSessions: vi.fn(() => []),
      getSession: vi.fn(),
      getAllSessions: vi.fn(() => [])
    },
    claude: {
      id: 'claude-chat',
      provider: 'claude',
      configure: vi.fn(),
      spawn: vi.fn(async (spec: { id: string }) => ({ id: spec.id })),
      kill: vi.fn(async () => undefined)
    },
    codexConfigure: vi.fn(),
    hasCodexRollout: vi.fn<(threadId: string, root: string) => boolean>(() => true),
    streams: new Map<string, (stream: unknown) => void>(),
    remembered: vi.fn<(adapterId: string) => string | undefined>(() => undefined),
    rememberedEffort: vi.fn<(adapterId: string) => string | undefined>(() => undefined),
    findTranscript: vi.fn<(id: string, cwd: string, configDir?: string) => string | null>(),
    title: { scheduleChatTitle: vi.fn(), cleanup: vi.fn(), cancelAll: vi.fn() },
    manager: {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      adopt: vi.fn((record: { id: string }) => handles.set(record.id, record)),
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
  buildSpawnEnv: (base: Record<string, string>) => ({ ...base }),
  codexHomeForSpawn: () => undefined,
  getLoginShellEnv: () => ({})
}))
vi.mock('./session-history/codex', () => ({
  codexRoot: () => '/codex/sessions',
  findCodexThreadForSession: () => null,
  hasCodexRollout: mocks.hasCodexRollout
}))
vi.mock('./sessions/adapters/pty-adapter', () => ({
  ptyAdapter: { id: 'pty', provider: 'terminal', prepare: vi.fn(), detach: vi.fn() }
}))
vi.mock('./sessions/adapters/claude-adapter', () => ({
  ClaudeAdapter: class {
    constructor() {
      return mocks.claude
    }
  },
  findTranscript: mocks.findTranscript
}))
vi.mock('./sessions/adapters/codex-adapter', () => ({
  CodexAdapter: class {
    id = 'codex-chat'
    provider = 'codex'
    configure = mocks.codexConfigure
  }
}))
vi.mock('./sessions/adapters/echo-adapter', () => ({
  EchoAdapter: class {
    id = 'echo'
    provider = 'echo'
  }
}))
vi.mock('./sessions/chat-model-default', () => ({
  rememberedChatModel: mocks.remembered,
  rememberedChatEffort: mocks.rememberedEffort
}))
vi.mock('./sessions/chat-view-default', () => ({
  initialChatView: (profileDefault: string | undefined) => profileDefault
}))
vi.mock('./sessions/session-manager', () => ({ sessionManager: mocks.manager }))
vi.mock('./title-generator', () => mocks.title)
vi.mock('./launch-profile-manager', () => ({
  defaultViewFor: () => 'clave.chat-view/chat',
  eventsProfile: (id?: string) =>
    id === 'claude-chat' || id === 'codex-chat' ? { id, adapterId: id } : undefined,
  isEchoLaunchProfile: () => false,
  launchProfileManager: { resolve: () => ({ id: 'claude-chat' }) }
}))

import { ptyManager } from './pty-manager'

const TAB = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handles.clear()
  mocks.manager.getAdapter.mockReturnValue(mocks.claude)
  mocks.findTranscript.mockReturnValue('/transcripts/conversation.jsonl')
  mocks.remembered.mockReturnValue(undefined)
  mocks.rememberedEffort.mockReturnValue(undefined)
  mocks.hasCodexRollout.mockReturnValue(true)
  mocks.backend.getSessionRecord.mockImplementation(() => null)
  mocks.streams.clear()
  mocks.manager.subscribe.mockImplementation((id: string, listener: (stream: unknown) => void) => {
    mocks.streams.set(id, listener)
    return () => mocks.streams.delete(id)
  })
})

describe('a Claude chat tab survives a restart', () => {
  it('writes its session record at spawn', async () => {
    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      model: 'opus',
      dangerousMode: true,
      workspaceId: 'ws',
      windowKey: 'win'
    })

    expect(mocks.backend.writeEventSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        adapterId: 'claude-chat',
        transport: 'events',
        claudeSessionId: session.claudeSessionId,
        claudeMode: true,
        launchProfileId: 'claude-chat',
        model: 'opus',
        dangerousMode: true,
        workspaceId: 'ws',
        windowKey: 'win',
        cwd: '/project'
      })
    )
  })

  it('comes back under its own id, resuming its conversation', async () => {
    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      adoptSessionId: TAB,
      resumeSessionId: CONVERSATION
    })

    expect(session.id).toBe(TAB)
    expect(session.claudeSessionId).toBe(CONVERSATION)
    expect(mocks.claude.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: TAB,
        options: expect.objectContaining({ resume: CONVERSATION })
      })
    )
  })

  it('keeps the name it was saved under in the record it rewrites', async () => {
    mocks.backend.getSessionRecord.mockImplementation(((id: string) =>
      id === TAB ? { id: TAB, displayName: 'Hackathon', userRenamed: true } : null) as never)

    await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      adoptSessionId: TAB,
      resumeSessionId: CONVERSATION
    })

    expect(mocks.backend.writeEventSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ id: TAB, displayName: 'Hackathon', userRenamed: true })
    )
  })

  it('relaunches fresh under the same id when the tab never got a message', async () => {
    mocks.findTranscript.mockReturnValue(null)

    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      adoptSessionId: TAB,
      resumeSessionId: CONVERSATION
    })

    expect(session.claudeSessionId).toBe(CONVERSATION)
    const spec = mocks.claude.spawn.mock.calls[0][0] as unknown as { options: { resume?: string } }
    expect(spec.options.resume).toBeUndefined()
    expect(mocks.claude.configure).toHaveBeenCalledWith(
      TAB,
      expect.objectContaining({ claudeSessionId: CONVERSATION })
    )
  })

  it('drops the record on a real close and keeps it on quit', async () => {
    const closed = await ptyManager.spawn('/project', { launchProfileId: 'claude-chat' })
    const kept = await ptyManager.spawn('/project', { launchProfileId: 'claude-chat' })

    await ptyManager.kill(closed.id)
    await ptyManager.kill(kept.id, false)

    expect(mocks.backend.discardSessionRecord).toHaveBeenCalledTimes(1)
    expect(mocks.backend.discardSessionRecord).toHaveBeenCalledWith(closed.id)
  })
})

// A Codex chat tab wrote no record, so it was gone at the next launch while
// every Claude chat tab beside it came back: a workspace worked in Codex lost
// all its tabs at every restart. The record is written at spawn, carries the
// thread the app-server opened, and a restore resumes that thread — unless
// the thread never got a message, which Codex cannot resume.
describe('a Codex chat tab survives a restart', () => {
  const THREAD = '01a0e825-64d8-7bf3-9bd4-5a09ab6e5e09'
  const codexChat = {
    id: 'codex-chat',
    provider: 'codex',
    spawn: mocks.claude.spawn,
    kill: mocks.claude.kill
  }
  const spawned = (): { options: { resume?: string } } =>
    mocks.claude.spawn.mock.calls.at(-1)?.[0] as unknown as { options: { resume?: string } }

  beforeEach(() => {
    mocks.manager.getAdapter.mockImplementation((id: string) =>
      id === 'codex-chat' ? codexChat : mocks.claude
    )
  })

  it('writes its session record at spawn', async () => {
    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'codex-chat',
      model: 'gpt-5.5',
      dangerousMode: true,
      codexAccountId: 'acct-2',
      codexAccountLabel: 'Work',
      workspaceId: 'ws-2',
      windowKey: 'win'
    })

    expect(mocks.backend.writeEventSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        adapterId: 'codex-chat',
        transport: 'events',
        codexMode: true,
        claudeMode: false,
        launchProfileId: 'codex-chat',
        model: 'gpt-5.5',
        dangerousMode: true,
        codexAccountId: 'acct-2',
        codexAccountLabel: 'Work',
        workspaceId: 'ws-2',
        windowKey: 'win',
        cwd: '/project'
      })
    )
  })

  it('records the thread the app-server opened', async () => {
    const session = await ptyManager.spawn('/project', { launchProfileId: 'codex-chat' })
    ptyManager.attachListeners(
      session.id,
      () => undefined,
      () => undefined
    )

    mocks.streams.get(session.id)?.({
      kind: 'event',
      event: { type: 'session_meta', model: 'gpt-5.5', providerSessionId: THREAD }
    })

    expect(mocks.backend.setSessionCodexThreadId).toHaveBeenCalledWith(session.id, THREAD)
  })

  it('comes back under its own id, resuming its thread', async () => {
    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'codex-chat',
      adoptSessionId: TAB,
      resumeSessionId: THREAD
    })

    expect(session.id).toBe(TAB)
    expect(mocks.hasCodexRollout).toHaveBeenCalledWith(THREAD, '/codex/sessions')
    expect(spawned().options.resume).toBe(THREAD)
    expect(mocks.backend.writeEventSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ id: TAB, codexThreadId: THREAD })
    )
    expect(mocks.title.scheduleChatTitle).not.toHaveBeenCalled()
  })

  it('starts fresh under the same id when its thread never got a message', async () => {
    mocks.hasCodexRollout.mockReturnValue(false)

    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'codex-chat',
      adoptSessionId: TAB,
      resumeSessionId: THREAD
    })

    expect(session.id).toBe(TAB)
    expect(spawned().options.resume).toBeUndefined()
    expect(mocks.title.scheduleChatTitle).toHaveBeenCalledWith(TAB, expect.anything())
  })

  it('drops the record on a real close and keeps it on quit', async () => {
    const closed = await ptyManager.spawn('/project', { launchProfileId: 'codex-chat' })
    const kept = await ptyManager.spawn('/project', { launchProfileId: 'codex-chat' })

    await ptyManager.kill(closed.id)
    await ptyManager.kill(kept.id, false)

    expect(mocks.backend.discardSessionRecord).toHaveBeenCalledTimes(1)
    expect(mocks.backend.discardSessionRecord).toHaveBeenCalledWith(closed.id)
  })
})

// A chat tab is named by its first message. The facade knows which tabs start
// a fresh conversation — the terminal path decides the same at spawn — and a
// resumed conversation keeps the name it was saved under.
describe('a chat tab is named by its first message', () => {
  it('a fresh chat tab waits for its first message, to be named by the agent it runs', async () => {
    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      workspaceId: 'ws-1',
      claudeProfileId: 'acct-work',
      configDir: '/Users/me/.claude-work'
    })
    expect(mocks.title.scheduleChatTitle).toHaveBeenCalledWith(session.id, {
      workspaceId: 'ws-1',
      launchProfileId: 'claude-chat',
      claudeProfileId: 'acct-work',
      configDir: '/Users/me/.claude-work'
    })
  })

  it('a chat on another agent waits too, with its own profile for the resolver to refuse', async () => {
    // Codex answers no Claude prompt; the launch profile manager's Claude-CLI
    // resolver is what turns this profile into the workspace's Claude.
    mocks.manager.getAdapter.mockImplementation((id: string) =>
      id === 'codex-chat'
        ? {
            id: 'codex-chat',
            provider: 'codex',
            spawn: mocks.claude.spawn,
            kill: mocks.claude.kill
          }
        : mocks.claude
    )
    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'codex-chat',
      workspaceId: 'ws-1'
    })
    expect(mocks.title.scheduleChatTitle).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ workspaceId: 'ws-1', launchProfileId: 'codex-chat' })
    )
  })

  it('a launch prompt reaches a Codex chat tab as it reaches a Claude one', async () => {
    // A workspace session's prompt used to be handed to the Claude adapter
    // only; the Codex adapter got the profile and the environment and the
    // prompt vanished, so a Codex tab opened empty where a Claude tab opened
    // on the prompt's answer.
    mocks.manager.getAdapter.mockImplementation((id: string) =>
      id === 'codex-chat'
        ? {
            id: 'codex-chat',
            provider: 'codex',
            spawn: mocks.claude.spawn,
            kill: mocks.claude.kill
          }
        : mocks.claude
    )
    const codex = await ptyManager.spawn('/project', {
      launchProfileId: 'codex-chat',
      initialPrompt: 'read the brief'
    })
    expect(mocks.codexConfigure).toHaveBeenCalledWith(
      codex.id,
      expect.anything(),
      expect.anything(),
      'read the brief'
    )
    const claude = await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      initialPrompt: 'read the brief'
    })
    expect(mocks.claude.configure).toHaveBeenCalledWith(
      claude.id,
      expect.objectContaining({ initialPrompt: 'read the brief' })
    )
  })

  it('a resumed conversation keeps the name it was saved under', async () => {
    await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      adoptSessionId: TAB,
      resumeSessionId: CONVERSATION
    })
    expect(mocks.title.scheduleChatTitle).not.toHaveBeenCalled()
  })

  it('a restored tab that never got a message is named by the one it gets now', async () => {
    mocks.findTranscript.mockReturnValue(null)
    await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      adoptSessionId: TAB,
      resumeSessionId: CONVERSATION
    })
    expect(mocks.title.scheduleChatTitle).toHaveBeenCalledWith(TAB, expect.anything())
  })

  it('a closed tab stops waiting', async () => {
    const session = await ptyManager.spawn('/project', { launchProfileId: 'claude-chat' })
    await ptyManager.kill(session.id)
    expect(mocks.title.cleanup).toHaveBeenCalledWith(session.id)
  })
})

describe('a new chat starts on the model last picked in a composer', () => {
  const launched = (): unknown =>
    (mocks.claude.spawn.mock.calls.at(-1)?.[0] as unknown as { options: { model?: string } })
      .options.model

  it('uses the remembered model when the launch names none', async () => {
    mocks.remembered.mockReturnValue('opus')
    const session = await ptyManager.spawn('/project', { launchProfileId: 'claude-chat' })
    expect(mocks.remembered).toHaveBeenCalledWith('claude-chat')
    expect(launched()).toBe('opus')
    expect(session.model).toBe('opus')
    expect(mocks.backend.writeEventSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'opus' })
    )
  })

  it('keeps a model the launch names', async () => {
    mocks.remembered.mockReturnValue('opus')
    await ptyManager.spawn('/project', { launchProfileId: 'claude-chat', model: 'haiku' })
    expect(launched()).toBe('haiku')
  })

  it('leaves a restored tab on its own model', async () => {
    mocks.remembered.mockReturnValue('opus')
    await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      adoptSessionId: TAB,
      resumeSessionId: CONVERSATION
    })
    expect(launched()).toBeUndefined()
  })

  it('starts on the CLI default when nothing was picked', async () => {
    await ptyManager.spawn('/project', { launchProfileId: 'claude-chat' })
    expect(launched()).toBeUndefined()
  })
})

describe("a chat tab's dangerous mode reaches its agent", () => {
  it('asks Codex for full access, not only for no approvals', async () => {
    const codex = { ...mocks.claude, id: 'codex-chat', provider: 'codex' }
    mocks.manager.getAdapter.mockReturnValue(codex)
    await ptyManager.spawn('/project', { launchProfileId: 'codex-chat', dangerousMode: true })
    expect(codex.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ permissionMode: 'never', sandbox: 'danger-full-access' })
      })
    )
  })

  it('leaves a Codex tab without it to its profile and config', async () => {
    const codex = { ...mocks.claude, id: 'codex-chat', provider: 'codex' }
    mocks.manager.getAdapter.mockReturnValue(codex)
    await ptyManager.spawn('/project', { launchProfileId: 'codex-chat' })
    const options = (codex.spawn.mock.calls[0] as unknown as [{ options: object }])[0].options
    expect(options).not.toHaveProperty('sandbox', expect.anything())
    expect(options).not.toHaveProperty('permissionMode', expect.anything())
  })

  it('asks Claude to bypass permissions', async () => {
    await ptyManager.spawn('/project', { launchProfileId: 'claude-chat', dangerousMode: true })
    expect(mocks.claude.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ permissionMode: 'bypassPermissions' })
      })
    )
  })
})

describe('a chat starts on the effort last picked in a composer', () => {
  const launched = (): unknown =>
    (mocks.claude.spawn.mock.calls.at(-1)?.[0] as unknown as { options: { effort?: string } })
      .options.effort

  it('hands the remembered effort to the adapter, per adapter', async () => {
    mocks.rememberedEffort.mockReturnValue('xhigh')
    await ptyManager.spawn('/project', { launchProfileId: 'claude-chat' })
    expect(mocks.rememberedEffort).toHaveBeenCalledWith('claude-chat')
    expect(launched()).toBe('xhigh')
  })

  it('keeps it for a restored tab, whose record holds no effort of its own', async () => {
    mocks.rememberedEffort.mockReturnValue('low')
    await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      adoptSessionId: TAB,
      resumeSessionId: CONVERSATION
    })
    expect(launched()).toBe('low')
  })

  it('starts on the CLI default when nothing was picked', async () => {
    await ptyManager.spawn('/project', { launchProfileId: 'claude-chat' })
    expect(launched()).toBeUndefined()
  })
})
