import { beforeEach, describe, expect, it, vi } from 'vitest'

// Lane D (PRDCT-4427): a tab goes from its chat to its terminal and back on
// the same conversation. These pin the facade's half: the restart's plan,
// built from the live spawn, names the other transport of the same harness,
// resumes the conversation the way its CLI resumes it, and leaves the chat
// view behind on the way to the terminal; a move between two chats still
// goes through the provider switch.

const mocks = vi.hoisted(() => {
  const handles = new Map<string, { id: string; adapterId?: string }>()
  const terminals = new Map<string, Record<string, unknown>>()
  return {
    handles,
    terminals,
    backend: {
      writeEventSessionRecord: vi.fn(() => true),
      discardSessionRecord: vi.fn(),
      setSessionViewRecord: vi.fn(),
      setSessionWorkspace: vi.fn(),
      setSessionClaudeSessionId: vi.fn(),
      setSessionRuntime: vi.fn(),
      setSessionCodexThreadId: vi.fn(),
      getSessionRecord: vi.fn<(id: string) => unknown>(() => null),
      tmuxNameOf: vi.fn(() => null),
      waitForTmuxSessionGone: vi.fn(async () => undefined),
      listAdoptableSessions: vi.fn(() => []),
      getSession: vi.fn((id: string) => terminals.get(id)),
      getAllSessions: vi.fn(() => [])
    },
    pty: {
      id: 'pty',
      provider: 'terminal',
      prepare: vi.fn(),
      detach: vi.fn()
    },
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
    streams: new Map<string, (stream: unknown) => void>(),
    /** The family's selected profile, when a test makes it a chat. */
    selected: null as null | string,
    findTranscript: vi.fn<(id: string, cwd: string, configDir?: string) => string | null>(),
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
  buildSpawnEnv: (base: Record<string, string>) => ({ ...base }),
  codexHomeForSpawn: () => undefined,
  getLoginShellEnv: () => ({})
}))
vi.mock('./session-history/codex', () => ({
  codexRoot: () => '/codex/sessions',
  findCodexThreadForSession: () => null,
  hasCodexRollout: () => true
}))
vi.mock('./sessions/adapters/pty-adapter', () => ({ ptyAdapter: mocks.pty }))
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
    constructor() {
      return mocks.codex
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
    id === 'claude-chat' || id === 'codex-chat'
      ? { id, adapterId: id }
      : id?.startsWith('chat:claude:')
        ? { id, adapterId: 'claude-chat', sourceProfileId: id.slice('chat:claude:'.length) }
        : undefined,
  isEchoLaunchProfile: () => false,
  launchProfileManager: {
    resolve: (family: string) => ({
      id: mocks.selected ?? (family === 'codex' ? 'codex-default' : 'claude-default')
    })
  }
}))

import { ptyManager } from './pty-manager'

const CONVERSATION = '33333333-3333-4333-8333-333333333333'
const THREAD = '44444444-4444-4444-8444-444444444444'

/** The record each tab's spawn wrote, as the backend would read it back. */
function recordFor(id: string, adapterId: string): void {
  mocks.backend.getSessionRecord.mockImplementation(((key: string) =>
    key === id ? { id, adapterId } : null) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handles.clear()
  mocks.terminals.clear()
  mocks.findTranscript.mockReturnValue('/transcripts/conversation.jsonl')
  mocks.selected = null
  mocks.backend.getSessionRecord.mockImplementation(() => null)
  mocks.manager.getAdapter.mockImplementation(((id: string) =>
    id === 'codex-chat' ? mocks.codex : mocks.claude) as never)
  mocks.manager.subscribe.mockImplementation((id: string, listener: (stream: unknown) => void) => {
    mocks.streams.set(id, listener)
    return () => mocks.streams.delete(id)
  })
  let n = 0
  mocks.pty.prepare.mockImplementation((cwd: string, options: Record<string, unknown>) => {
    n += 1
    const session = {
      id: `5555555${n}-5555-4555-8555-555555555555`,
      cwd,
      folderName: 'project',
      alive: true,
      ptyProcess: null,
      claudeSessionId: options.claudeMode === false ? undefined : CONVERSATION,
      startedAt: Date.now()
    }
    mocks.terminals.set(session.id, session)
    return session
  })
})

describe('chat to terminal on the same conversation (lane D, PRDCT-4427)', () => {
  it('a Claude chat restarted onto pty resumes its session in the terminal, the chat view left behind', async () => {
    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      claudeMode: true,
      viewId: 'clave.chat-view/lab',
      effort: 'high'
    })
    recordFor(session.id, 'claude-chat')
    const plan = ptyManager.restartSpawn(session.id, { adapterId: 'pty' })
    expect(plan).toMatchObject({ resumed: true, keepView: false })
    expect(plan?.options.resumeSessionId).toBe(session.claudeSessionId)
    expect(plan?.options.adoptSessionId).toBe(session.id)
    expect(plan?.options.launchProfileId).toBeUndefined()
    expect(plan?.options.viewId).toBeUndefined()
    expect(plan?.options.claudeSessionId).toBeUndefined()
  })
  it('a Claude chat that never wrote a transcript starts its terminal under the same id (--session-id), not a resume', async () => {
    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      claudeMode: true
    })
    recordFor(session.id, 'claude-chat')
    mocks.findTranscript.mockReturnValue(null)
    const plan = ptyManager.restartSpawn(session.id, { adapterId: 'pty' })
    expect(plan?.options.resumeSessionId).toBeUndefined()
    expect(plan?.options.claudeSessionId).toBe(session.claudeSessionId)
    expect(plan?.keepView).toBe(false)
  })
  it('lands on a terminal even when the family’s selected profile is a chat', async () => {
    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      claudeMode: true
    })
    recordFor(session.id, 'claude-chat')
    mocks.selected = 'claude-chat'
    expect(ptyManager.restartSpawn(session.id, { adapterId: 'pty' })?.options.launchProfileId).toBe(
      'builtin-claude'
    )
    mocks.selected = 'chat:claude:work-flags'
    expect(ptyManager.restartSpawn(session.id, { adapterId: 'pty' })?.options.launchProfileId).toBe(
      'work-flags'
    )
  })
  it('a Codex chat restarted onto pty resumes its thread in the terminal', async () => {
    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'codex-chat',
      claudeMode: false,
      codexMode: true
    })
    ptyManager.attachListeners(
      session.id,
      () => undefined,
      () => undefined
    )
    mocks.streams.get(session.id)?.({
      kind: 'event',
      event: { type: 'session_meta', model: 'gpt-5.5', providerSessionId: THREAD }
    })
    recordFor(session.id, 'codex-chat')
    const plan = ptyManager.restartSpawn(session.id, { adapterId: 'pty' })
    expect(plan).toMatchObject({ resumed: true, keepView: false })
    expect(plan?.options).toMatchObject({ codexMode: true, resumeSessionId: THREAD })
    expect(plan?.options.launchProfileId).toBeUndefined()
    expect(plan?.options.viewId).toBeUndefined()
    // No transcript guard for Codex: its thread is the rollout it was found by.
    expect(plan?.options.claudeSessionId).toBeUndefined()
  })
})

describe('terminal to chat on the same conversation (lane D, PRDCT-4427)', () => {
  it('a Claude terminal restarted onto claude-chat resumes its session on the chat profile, in the view picked', async () => {
    const session = await ptyManager.spawn('/project', { claudeMode: true })
    recordFor(session.id, 'pty')
    const plan = ptyManager.restartSpawn(session.id, {
      adapterId: 'claude-chat',
      viewId: 'clave.chat-view/lab'
    })
    expect(plan).toMatchObject({ resumed: true, keepView: false })
    expect(plan?.options).toMatchObject({
      launchProfileId: 'claude-chat',
      resumeSessionId: CONVERSATION,
      viewId: 'clave.chat-view/lab',
      adoptSessionId: session.id
    })
  })
  it('a terminal with no conversation to carry is refused, never opened as a fresh chat (amendment 1)', async () => {
    const session = await ptyManager.spawn('/project', { claudeMode: false, codexMode: true })
    recordFor(session.id, 'pty')
    expect(() =>
      ptyManager.restartSpawn(session.id, {
        adapterId: 'codex-chat',
        viewId: 'clave.chat-view/chat'
      })
    ).toThrow('This terminal has no conversation to carry into a chat yet.')
  })
})

describe('a move between two chats is still the provider switch (PRDCT-4300)', () => {
  it('a Claude chat restarted onto codex-chat keeps its view and resumes only what the switch names', async () => {
    const session = await ptyManager.spawn('/project', {
      launchProfileId: 'claude-chat',
      claudeMode: true
    })
    recordFor(session.id, 'claude-chat')
    const plan = ptyManager.restartSpawn(session.id, {
      adapterId: 'codex-chat',
      resume: THREAD
    })
    expect(plan).toMatchObject({ resumed: true, keepView: true })
    expect(plan?.options).toMatchObject({
      codexMode: true,
      launchProfileId: 'codex-chat',
      resumeSessionId: THREAD
    })
  })
  it('a restart that names no adapter keeps the view', async () => {
    const session = await ptyManager.spawn('/project', { launchProfileId: 'claude-chat' })
    recordFor(session.id, 'claude-chat')
    expect(ptyManager.restartSpawn(session.id, { claudeProfileId: 'play' })?.keepView).toBe(true)
  })
})
