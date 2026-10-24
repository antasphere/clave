import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LaunchProfile } from '../shared/agent-launch'

const mocks = vi.hoisted(() => {
  const handles = new Map<string, { id: string }>()
  return {
    handles,
    loginEnv: vi.fn(() => ({ PATH: '' })),
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
    title: { scheduleChatTitle: vi.fn(), cleanup: vi.fn(), cancelAll: vi.fn(), shutdown: vi.fn() },
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
  getLoginShellEnv: mocks.loginEnv
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
    id?.startsWith('chat:claude:')
      ? { id, adapterId: 'claude-chat' }
      : id?.startsWith('chat:codex:')
        ? { id, adapterId: 'codex-chat' }
        : undefined,
  isEchoLaunchProfile: () => false,
  launchProfileManager: { resolve: () => ({ id: 'claude-chat' }) }
}))

import { ptyManager } from './pty-manager'

const dir = mkdtempSync(join(tmpdir(), 'clave-carried-profile-'))
const executable = 'mac-wrapper'
writeFileSync(join(dir, executable), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const carried = (family: 'claude' | 'codex'): LaunchProfile => ({
  id: `chat:${family}:mac-only`,
  name: 'Mac only',
  family,
  command: [executable, family],
  additionalArgs: ['--verbose'],
  sourceProfileId: 'mac-only'
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handles.clear()
  mocks.loginEnv.mockReturnValue({ PATH: dir })
  mocks.findTranscript.mockReturnValue('/transcript.jsonl')
  mocks.manager.getAdapter.mockImplementation((id: string) =>
    id === 'codex-chat' ? { ...mocks.claude, id: 'codex-chat', provider: 'codex' } : mocks.claude
  )
})

describe('a server starts the carried launch profile', () => {
  it('configures Codex chat with the Mac definition and records it', async () => {
    const profile = carried('codex')
    const session = await ptyManager.spawn('/project', {
      codexMode: true,
      launchProfileId: profile.id,
      launchProfile: profile
    })
    expect(mocks.codexConfigure).toHaveBeenCalledWith(
      session.id,
      profile,
      expect.anything(),
      undefined
    )
    expect(mocks.backend.writeEventSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        launchProfileId: profile.id,
        launchProfile: profile
      })
    )
    const restart = ptyManager.restartSpawn(session.id, { codexAccountId: 'another-account' })
    expect(restart?.options.launchProfile).toEqual(profile)
    expect(restart?.options.codexAccountId).toBe('another-account')
  })

  it('configures Claude chat with the carried definition', async () => {
    const profile = carried('claude')
    const session = await ptyManager.spawn('/project', {
      claudeMode: true,
      launchProfileId: profile.id,
      launchProfile: profile
    })
    expect(mocks.claude.configure).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ launchProfile: profile })
    )
    expect(ptyManager.restartSpawn(session.id, {})?.options.launchProfile).toEqual(profile)
  })

  it('refuses a program missing from the server PATH before adapter spawn', async () => {
    const profile = { ...carried('codex'), command: ['missing-mac-program'] }
    await expect(
      ptyManager.spawn('/project', {
        codexMode: true,
        launchProfile: profile
      })
    ).rejects.toThrow('Program "missing-mac-program" was not found on this server')
    expect(mocks.claude.spawn).not.toHaveBeenCalled()
    expect(mocks.backend.writeEventSessionRecord).not.toHaveBeenCalled()
  })

  it('refuses a carried family that does not match the start', async () => {
    await expect(
      ptyManager.spawn('/project', {
        claudeMode: true,
        launchProfile: carried('codex')
      })
    ).rejects.toThrow('Launch profile "Mac only" is for codex, not claude')
    expect(mocks.claude.spawn).not.toHaveBeenCalled()
  })

  it('refuses managed arguments before any adapter starts', async () => {
    await expect(
      ptyManager.spawn('/project', {
        claudeMode: true,
        launchProfile: { ...carried('claude'), additionalArgs: ['--model', 'opus'] }
      })
    ).rejects.toThrow('The carried launch profile is not valid')
    expect(mocks.claude.spawn).not.toHaveBeenCalled()
  })

  it('sanitizes the options the adapter, record and restart retain', async () => {
    const profile = carried('claude')
    const session = await ptyManager.spawn('/project', {
      launchProfile: { ...profile, builtIn: true, name: ' Mac only ' }
    })
    expect(mocks.claude.configure).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ launchProfile: profile })
    )
    expect(ptyManager.restartSpawn(session.id, {})?.options.launchProfile).toEqual(profile)
    expect(mocks.backend.writeEventSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ launchProfile: profile })
    )
  })
})
