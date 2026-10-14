import { beforeEach, describe, expect, it, vi } from 'vitest'

// A live tmux session this process takes BACK (an app relaunch, a move from
// another window) is born with the word its hooks last wrote; a fresh spawn,
// and a reattach whose hooks never wrote, start idle (PRDCT-3289). These pin
// the facade's wiring of `lastHookState` into the record the session manager
// adopts; the manager's own test pins what the word means for the watch.

const mocks = vi.hoisted(() => {
  const adopted: { id: string; state: string }[] = []
  return {
    adopted,
    lastHookState: vi.fn<(id: string) => string | null>(() => null),
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
    prepare: vi.fn(
      (cwd: string, options?: { adoptSessionId?: string; adoptTmuxName?: string }) => ({
        id: options?.adoptSessionId ?? '22222222-2222-4222-8222-222222222222',
        cwd,
        folderName: 'w',
        alive: true,
        ptyProcess: null,
        tmuxName: options?.adoptTmuxName
      })
    ),
    manager: {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      adopt: vi.fn((record: { id: string; state: string }) => adopted.push(record)),
      get: vi.fn(),
      kill: vi.fn(async () => undefined),
      forget: vi.fn(),
      list: vi.fn(() => []),
      subscribe: vi.fn(() => () => undefined),
      subscribeExit: vi.fn(() => () => undefined)
    },
    title: { scheduleChatTitle: vi.fn(), cleanup: vi.fn(), cancelAll: vi.fn(), shutdown: vi.fn() }
  }
})

vi.mock('./agent-state-manager', () => ({ lastHookState: mocks.lastHookState }))
vi.mock('./sessions/adapters/pty-backend', () => ({
  ptyBackend: mocks.backend,
  buildSpawnEnv: (base: Record<string, string>) => ({ ...base }),
  codexHomeForSpawn: () => undefined,
  getLoginShellEnv: () => ({})
}))
vi.mock('./session-history/codex', () => ({
  codexRoot: () => '/codex/sessions',
  findCodexThreadForSession: () => null,
  hasCodexRollout: () => true
}))
vi.mock('./sessions/adapters/pty-adapter', () => ({
  ptyAdapter: { id: 'pty', provider: 'terminal', prepare: mocks.prepare, detach: vi.fn() }
}))
vi.mock('./sessions/adapters/claude-adapter', () => ({
  ClaudeAdapter: class {
    id = 'claude-chat'
    provider = 'claude'
    configure = vi.fn()
  },
  findTranscript: () => null
}))
vi.mock('./sessions/adapters/codex-adapter', () => ({
  CodexAdapter: class {
    id = 'codex-chat'
    provider = 'codex'
    configure = vi.fn()
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
vi.mock('./sessions/chat-view-default', () => ({
  initialChatView: (profileDefault: string | undefined) => profileDefault
}))
vi.mock('./sessions/session-manager', () => ({ sessionManager: mocks.manager }))
vi.mock('./title-generator', () => mocks.title)
vi.mock('./launch-profile-manager', () => ({
  defaultViewFor: () => undefined,
  // A terminal profile for every family: the spawn stays on the pty adapter.
  eventsProfile: () => undefined,
  isEchoLaunchProfile: () => false,
  launchProfileManager: { resolve: () => ({ id: 'claude' }) }
}))

import { ptyManager } from './pty-manager'

const ID = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.adopted.length = 0
  mocks.lastHookState.mockReturnValue(null)
})

describe('the word a spawned session is born with', () => {
  it('a live tmux session taken back is born with the word its hooks last wrote', async () => {
    mocks.lastHookState.mockReturnValue('working')
    await ptyManager.spawn('/w', {
      claudeMode: true,
      tmuxMode: true,
      adoptTmuxName: 'clave-w',
      adoptSessionId: ID
    })
    expect(mocks.lastHookState).toHaveBeenCalledWith(ID)
    expect(mocks.adopted.map((r) => [r.id, r.state])).toEqual([[ID, 'working']])
  })

  it('a fresh spawn is born idle and never asks the hooks', async () => {
    mocks.lastHookState.mockReturnValue('working')
    await ptyManager.spawn('/w', { claudeMode: true, tmuxMode: true })
    expect(mocks.lastHookState).not.toHaveBeenCalled()
    expect(mocks.adopted.map((r) => r.state)).toEqual(['idle'])
  })

  it('a dead record relaunched fresh (no tmux session to reattach) is born idle too', async () => {
    mocks.lastHookState.mockReturnValue('working')
    await ptyManager.spawn('/w', { claudeMode: true, adoptTmuxName: 'clave-w', adoptSessionId: ID })
    expect(mocks.lastHookState).not.toHaveBeenCalled()
    expect(mocks.adopted.map((r) => r.state)).toEqual(['idle'])
  })

  it('a reattach whose hooks never wrote, or wrote ended, is born idle', async () => {
    mocks.lastHookState.mockReturnValue(null)
    await ptyManager.spawn('/w', {
      claudeMode: true,
      tmuxMode: true,
      adoptTmuxName: 'clave-w',
      adoptSessionId: ID
    })
    expect(mocks.lastHookState).toHaveBeenCalledWith(ID)
    expect(mocks.adopted.map((r) => r.state)).toEqual(['idle'])
  })
})
