import { describe, expect, it } from 'vitest'
import { conversationProviderForSpawn, parseConversationCommand } from './launch'

describe('conversation launch boundary', () => {
  it('uses conversations for new supported agents, not terminal adoption', () => {
    expect(conversationProviderForSpawn()).toBe('claude')
    expect(conversationProviderForSpawn({ codexMode: true })).toBe('codex')
    expect(conversationProviderForSpawn({ piMode: true })).toBe('pi')
    expect(conversationProviderForSpawn({ claudeMode: false })).toBeNull()
    expect(conversationProviderForSpawn({ antigravityMode: true })).toBeNull()
    expect(conversationProviderForSpawn({ claudeAgentsMode: true })).toBeNull()
    expect(conversationProviderForSpawn({ adoptTmuxName: 'clave-existing' })).toBeNull()
    expect(conversationProviderForSpawn({ adoptSessionId: 'old-session' })).toBeNull()
  })

  it('accepts plain conversation input without exposing process configuration', () => {
    expect(
      parseConversationCommand({
        type: 'create',
        options: { provider: 'opencode', cwd: '/workspace' }
      })
    ).toEqual({ type: 'create', options: { provider: 'opencode', cwd: '/workspace' } })
    for (const extra of [
      { env: { SECRET: 'x' } },
      { command: ['sh'] },
      { windowKey: '../other' }
    ]) {
      expect(() =>
        parseConversationCommand({
          type: 'create',
          options: { provider: 'claude', cwd: '/workspace', ...extra }
        })
      ).toThrow()
    }
  })

  it('rejects malformed IDs, oversized input, and ambiguous approval responses', () => {
    const sessionId = 'conversation-7b7a0f34-ff31-4377-9725-f2a806a92a92'
    expect(() =>
      parseConversationCommand({ type: 'send', sessionId: '../escape', text: 'hi', commandId: '1' })
    ).toThrow()
    expect(() =>
      parseConversationCommand({
        type: 'send',
        sessionId,
        text: 'x'.repeat(1_048_577),
        commandId: '1'
      })
    ).toThrow()
    expect(() =>
      parseConversationCommand({
        type: 'respond',
        sessionId,
        response: { requestId: 'r', decision: 'allow', answer: 'yes' }
      })
    ).toThrow()
    expect(
      parseConversationCommand({ type: 'send', sessionId, text: 'hello', commandId: '1' }).type
    ).toBe('send')
  })
})
