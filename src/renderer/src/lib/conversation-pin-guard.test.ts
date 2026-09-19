import { describe, expect, it } from 'vitest'
import { assertPinnableSessions } from './conversation-pin-guard'

describe('direct-only conversation pin guard', () => {
  it('rejects OpenCode rather than serializing it as a shell', () => {
    expect(() =>
      assertPinnableSessions([
        { id: 'conversation-opencode', claudeMode: false, codexMode: false, piMode: false }
      ])
    ).toThrow('OpenCode sessions cannot be pinned or exported')
  })

  it('keeps plain terminals, legacy sessions and supported conversation providers pinnable', () => {
    expect(() =>
      assertPinnableSessions([
        { id: 'terminal', claudeMode: false, codexMode: false },
        { id: 'conversation-claude', claudeMode: true, codexMode: false },
        { id: 'conversation-codex', claudeMode: false, codexMode: true },
        { id: 'conversation-pi', claudeMode: false, codexMode: false, piMode: true }
      ])
    ).not.toThrow()
  })
})
