import { describe, expect, it, vi } from 'vitest'
import type { SessionManager } from './session-manager'

/**
 * The host's restart hands the lifecycle everything the wire carried: the
 * account, the flags, and the provider switch (PRDCT-4300, verifier round 1
 * F7: nothing pinned this hop, and a dropped spread left the tab on its old
 * provider with the store saying otherwise).
 */
const mocks = vi.hoisted(() => ({
  restartSession: vi.fn(async () => ({ id: 's1', resumed: true }))
}))
vi.mock('electron', () => {
  throw new Error('the host imported electron')
})
vi.mock('../pty-manager', () => ({ ptyManager: {} }))
vi.mock('./lifecycle', () => ({
  readScreen: vi.fn(),
  restartSession: mocks.restartSession,
  typeIntoSession: vi.fn(),
  resizeSession: vi.fn(),
  spawnSession: vi.fn(),
  stopSession: vi.fn(),
  writeTerminal: vi.fn()
}))
vi.mock('../title-generator', () => ({ notifyChatMessage: vi.fn() }))
vi.mock('./attachments', () => ({ preparePrompt: vi.fn() }))
vi.mock('./chat-model-default', () => ({ rememberChatEffort: vi.fn(), rememberChatModel: vi.fn() }))
vi.mock('./chat-view-default', () => ({ rememberChatView: vi.fn() }))
vi.mock('./records', () => ({ sessionRecords: {} }))
import { createSessionHost } from './host'

const host = createSessionHost({
  manager: { get: () => undefined } as unknown as SessionManager,
  lifecycle: { spawn: vi.fn(), stop: vi.fn(), resize: vi.fn(), writeTerminal: vi.fn() }
})

describe('the host’s restart (PRDCT-4300)', () => {
  it('merges the account, the flags and the provider switch into one lifecycle restart', async () => {
    const provider = {
      adapterId: 'codex-chat',
      model: 'gpt-5.5',
      resume: 'thread-7',
      continuedFrom: { provider: 'claude', road: 'converted' as const }
    }
    await host.restart(
      's1',
      { codexAccountId: 'c1', codexAccountLabel: 'Codex 1' },
      true,
      false,
      provider
    )
    expect(mocks.restartSession).toHaveBeenCalledExactlyOnceWith('s1', {
      codexAccountId: 'c1',
      codexAccountLabel: 'Codex 1',
      adapterId: 'codex-chat',
      model: 'gpt-5.5',
      resume: 'thread-7',
      continuedFrom: { provider: 'claude', road: 'converted' },
      resendRejected: true,
      onlyIfStopped: false
    })
  })
  it('a restart with no provider switch carries none', async () => {
    await host.restart('s1', { claudeProfileId: 'play' }, false, true)
    expect(mocks.restartSession).toHaveBeenLastCalledWith('s1', {
      claudeProfileId: 'play',
      resendRejected: false,
      onlyIfStopped: true
    })
  })
})
