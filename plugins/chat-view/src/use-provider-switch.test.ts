import { describe, expect, it, vi } from 'vitest'
import type { Conversation, Entry } from './reducer'

// The hook's module reaches the renderer's stores; the move's rules do not.
// The lib is mocked EXCEPT the budget, which stays the real one.
const h = vi.hoisted(() => ({
  switchSessionProvider: vi.fn(),
  requestHandoffNote: vi.fn(async () => 'A note from the agent.'),
  stored: { id: 's1', limitReported: null as unknown } as Record<string, unknown>
}))
vi.mock('../../../src/renderer/src/views/session-store', () => ({ useViewSessionStore: vi.fn() }))
vi.mock('../../../src/renderer/src/lib/switch-provider', () => ({
  canWriteHandoffNote: vi.fn(),
  planProviderSwitch: vi.fn(),
  providerSwitchLanding: vi.fn(),
  requestHandoffNote: h.requestHandoffNote,
  sessionById: () => h.stored,
  settleProviderSwitchAsk: vi.fn(),
  switchSessionProvider: h.switchSessionProvider,
  takeProviderSwitchAsk: vi.fn()
}))
import { handoffBudgetChars } from '../../../src/renderer/src/lib/handoff-budget'
import { midTurn, noteToAsk, performProviderSwitch } from './use-provider-switch'

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
})

describe('the move the popover makes on Continue (integration round 3, R2-4)', () => {
  const target = {
    adapterId: 'codex-chat',
    provider: 'codex',
    label: 'Codex',
    model: { id: 'gpt-5.5', label: 'GPT-5.5' }
  }
  const plan = {
    from: { adapterId: 'claude-chat', provider: 'claude' },
    to: { adapterId: 'codex-chat', provider: 'codex' },
    road: 'handoff' as const,
    reason: 'no transcript'
  }
  const at = new Date(2026, 10, 10, 1, 0).getTime()
  const conversation = (entries: Entry[]): Conversation =>
    ({
      entries,
      first: 0,
      state: 'idle',
      run: 1,
      model: 'claude-opus-5-5'
    }) as unknown as Conversation
  const electron = {
    sessionsHistory: vi.fn(async () => ({ items: [], before: null })),
    providerSwitchHandoff: vi.fn(async () => ({ path: '/tape.md', diffStat: null }))
  }
  Object.defineProperty(globalThis, 'window', {
    value: { electronAPI: electron },
    configurable: true,
    writable: true
  })
  const busy: string[] = []
  const run = (
    input: Partial<Parameters<typeof performProviderSwitch>[0]> = {}
  ): ReturnType<typeof performProviderSwitch> =>
    performProviderSwitch({
      sessionId: 's1',
      provider: 'claude',
      target,
      plan,
      note: false,
      working: false,
      source: { conversation: conversation([]), before: null },
      meta: { title: 'T', cwd: '/w', model: 'claude-opus-5-5' },
      onBusy: (b) => busy.push(b),
      onError: vi.fn(),
      ...input
    })
  it("carries the limit's rejected message when the tab holds a report, or when the card said so", async () => {
    h.switchSessionProvider.mockResolvedValue({ ok: true, resumed: false, road: 'handoff' })
    h.stored.limitReported = null
    await run()
    expect(h.switchSessionProvider.mock.calls.at(-1)![1]).toMatchObject({ resendRejected: false })
    h.stored.limitReported = { cap: 'fable' }
    await run()
    expect(h.switchSessionProvider.mock.calls.at(-1)![1]).toMatchObject({ resendRejected: true })
    h.stored.limitReported = null
    await run({ resendRejected: true })
    expect(h.switchSessionProvider.mock.calls.at(-1)![1]).toMatchObject({ resendRejected: true })
  })
  it('writes the handoff under the real budget of the target model, from the whole conversation', async () => {
    h.switchSessionProvider.mockImplementation(async (_id, input) => {
      const text = await input.handoff()
      return { ok: true, resumed: false, road: 'handoff', text }
    })
    const long: Entry[] = Array.from({ length: 600 }, (_, i) => [
      { kind: 'user' as const, text: `question ${i} ${'words '.repeat(300)}`, final: true, at },
      { kind: 'assistant' as const, text: `answer ${i} ${'words '.repeat(300)}`, final: true, at }
    ]).flat()
    const result = (await run({ source: { conversation: conversation(long), before: null } })) as {
      text: string
    }
    const budget = handoffBudgetChars('gpt-5.5')
    expect(budget).toBe(400_000)
    expect(result.text.length).toBeLessThanOrEqual(budget)
    expect(result.text).toContain('question 599 ')
    expect(result.text).toContain('question 0 ')
    expect(result.text).toContain('left out for room')
    // The whole tape went to the file first, uncut.
    const tape = electron.providerSwitchHandoff.mock.calls.at(-1)![1] as string
    expect(tape.length).toBeGreaterThan(budget)
  })
  it('asks the note first when ticked and idle, skips it mid-turn and says so', async () => {
    h.switchSessionProvider.mockResolvedValue({ ok: true, resumed: true, road: 'converted' })
    h.requestHandoffNote.mockClear()
    await run({ note: true, working: false })
    expect(h.requestHandoffNote).toHaveBeenCalledWith('s1')
    const onError = vi.fn()
    h.requestHandoffNote.mockClear()
    await run({ note: true, working: true, onError })
    expect(h.requestHandoffNote).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('skipped'))
  })
})
