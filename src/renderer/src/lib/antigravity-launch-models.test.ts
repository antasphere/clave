import { describe, expect, it, vi } from 'vitest'
import { launchModelsOf } from './launch-options-input'

// The session store reads localStorage at import; nothing here touches it.
vi.mock('../store/session-store', () => ({ useSessionStore: {} }))

describe("Antigravity's rows in the launch listing", () => {
  const source = {} as Parameters<typeof launchModelsOf>[0]
  it("lists the CLI's default, then what agy serves", () => {
    expect(
      launchModelsOf(source, 'antigravity', 'unavailable', [
        { id: 'gemini-4-neon', label: 'Gemini 4 Neon' }
      ])
    ).toEqual([
      { id: null, label: 'Default', family: 'Default' },
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon', family: 'Gemini 4 Neon' }
    ])
  })
  it('never borrows Codex’s list', () => {
    expect(launchModelsOf(source, 'antigravity', [{ id: 'gpt-5.5', label: 'GPT-5.5' }])).toBe(
      'unavailable'
    )
  })
})
