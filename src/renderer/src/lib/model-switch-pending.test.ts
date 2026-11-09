import { describe, expect, it } from 'vitest'
import { MODEL_SWITCH_WINDOW_MS, PendingModelSwitches } from './model-switch-pending'

/** The policy holds off a session whose model switch is not confirmed yet
 *  (PRDCT-4302): otherwise the view, still judged by the model the cap
 *  stopped, has the ladder offered again and automatic mode writes a second
 *  set_model. */
describe('PendingModelSwitches', () => {
  it('is in flight from the write until the store shows the model', () => {
    const p = new PendingModelSwitches()
    expect(p.inFlight('s1', 'claude-fable-5-1', 0)).toBe(false)
    p.begin('s1', 'claude-opus-5-5', 0)
    expect(p.inFlight('s1', 'claude-fable-5-1', 10)).toBe(true)
    expect(p.inFlight('s1', undefined, 20)).toBe(true)
    expect(p.inFlight('s1', 'claude-opus-5-5', 30)).toBe(false)
    // Settled: a later read of the old model is not a pending switch.
    expect(p.inFlight('s1', 'claude-fable-5-1', 40)).toBe(false)
  })
  it('settles when the window closes, so a refused switch does not hold the tab for good', () => {
    const p = new PendingModelSwitches()
    p.begin('s1', 'claude-opus-5-5', 0)
    expect(p.inFlight('s1', 'claude-fable-5-1', MODEL_SWITCH_WINDOW_MS)).toBe(true)
    expect(p.inFlight('s1', 'claude-fable-5-1', MODEL_SWITCH_WINDOW_MS + 1)).toBe(false)
    expect(p.inFlight('s1', 'claude-fable-5-1', MODEL_SWITCH_WINDOW_MS + 2)).toBe(false)
  })
  it('keeps sessions apart and forgets on demand', () => {
    const p = new PendingModelSwitches()
    p.begin('s1', 'claude-opus-5-5', 0)
    expect(p.inFlight('s2', 'claude-fable-5-1', 1)).toBe(false)
    p.forget('s1')
    expect(p.inFlight('s1', 'claude-fable-5-1', 1)).toBe(false)
  })
})
