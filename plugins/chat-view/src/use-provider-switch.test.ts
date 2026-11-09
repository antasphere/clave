import { describe, expect, it, vi } from 'vitest'
// The hook's module reaches the renderer's stores; the rules under test do not.
vi.mock('../../../src/renderer/src/views/session-store', () => ({ useViewSessionStore: vi.fn() }))
vi.mock('../../../src/renderer/src/lib/switch-provider', () => ({
  canWriteHandoffNote: vi.fn(),
  handoffBudgetChars: (id: string) => (id.startsWith('claude-') ? 2_000_000 : 400_000),
  settleProviderSwitchAsk: vi.fn(),
  takeProviderSwitchAsk: vi.fn(),
  planProviderSwitch: vi.fn(),
  providerSwitchLanding: vi.fn(),
  requestHandoffNote: vi.fn(),
  sessionById: vi.fn(),
  switchSessionProvider: vi.fn()
}))
import { handoffBudgetChars, midTurn, noteToAsk } from './use-provider-switch'

describe('the handoff note and the agent’s turn (verifier round 1 F5, round 2 R1 and R2)', () => {
  it('counts a turn held on a permission prompt as mid-turn, like a working one', () => {
    expect(midTurn('working')).toBe(true)
    expect(midTurn('blocked')).toBe(true)
    expect(midTurn('idle')).toBe(false)
    expect(midTurn('done')).toBe(false)
    expect(midTurn('ended')).toBe(false)
  })
  it('asks the ticked note only while the agent is idle at Continue, whatever it was when the popover opened', () => {
    expect(noteToAsk(true, false)).toBe(true)
    expect(noteToAsk(true, true)).toBe(false)
    expect(noteToAsk(false, false)).toBe(false)
  })
  it('sizes the handoff to half the target’s window, a 200k window when the id names none', () => {
    expect(handoffBudgetChars('claude-opus-5-5')).toBe(2_000_000)
    expect(handoffBudgetChars('gpt-5.5')).toBe(400_000)
  })
})
