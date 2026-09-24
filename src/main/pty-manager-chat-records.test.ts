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
    findTranscript: vi.fn<(id: string, cwd: string, configDir?: string) => string | null>(),
    title: { scheduleChatTitle: vi.fn(), cleanup: vi.fn() },
    manager: {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      adopt: vi.fn((record: { id: string }) => handles.set(record.id, record)),
      get: vi.fn((id: string) => handles.get(id)),
      kill: vi.fn(async () => undefined),
      forget: vi.fn((id: string) => handles.delete(id)),
      list: vi.fn(() => [...handles.values()])
    }
  }
})

vi.mock('./sessions/adapters/pty-backend', () => ({ ptyBackend: mocks.backend }))
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
  }
}))
vi.mock('./sessions/adapters/echo-adapter', () => ({
  EchoAdapter: class {
    id = 'echo'
    provider = 'echo'
  }
}))
vi.mock('./sessions/session-manager', () => ({ sessionManager: mocks.manager }))
vi.mock('./title-generator', () => mocks.title)
vi.mock('./launch-profile-manager', () => ({
  defaultViewFor: () => 'clave.chat-view/chat',
  eventsProfile: (id?: string) =>
    id === 'claude-chat' ? { id: 'claude-chat', adapterId: 'claude-chat' } : undefined,
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
      expect.objectContaining({ id: TAB, options: expect.objectContaining({ resume: CONVERSATION }) })
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

// A chat tab is named by its first message. The facade knows which tabs start
// a fresh conversation — the terminal path decides the same at spawn — and a
// resumed conversation keeps the name it was saved under.
describe('a chat tab is named by its first message', () => {
  it('a fresh chat tab waits for its first message', async () => {
    const session = await ptyManager.spawn('/project', { launchProfileId: 'claude-chat' })
    expect(mocks.title.scheduleChatTitle).toHaveBeenCalledWith(session.id)
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
    expect(mocks.title.scheduleChatTitle).toHaveBeenCalledWith(TAB)
  })

  it('a closed tab stops waiting', async () => {
    const session = await ptyManager.spawn('/project', { launchProfileId: 'claude-chat' })
    await ptyManager.kill(session.id)
    expect(mocks.title.cleanup).toHaveBeenCalledWith(session.id)
  })
})
