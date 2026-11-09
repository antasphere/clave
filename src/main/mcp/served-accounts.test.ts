import { describe, expect, it } from 'vitest'
import { accountForLaunch, resolveAccountRef, type AccountFacts } from './served-accounts'
import type { ServedPoolAccount } from './served-core'

/**
 * The served pool's pick for a launch is judged for the model the launch
 * will run (PRDCT-4253): an account whose Fable week is spent takes a launch
 * on Opus and refuses one on Fable. The same facts a routine run and the
 * served clave_open_session read.
 */
const week = { kind: 'weekly_all', scope: null, usedPercentage: 40, severity: 'normal' }
const fable = { kind: 'weekly_scoped', scope: 'Fable', usedPercentage: 100, severity: 'critical' }
const open = { kind: 'weekly_all', scope: null, usedPercentage: 10, severity: 'normal' }
const accounts: ServedPoolAccount[] = [
  {
    id: 'default',
    label: 'Default',
    usable: true,
    usage: { tightest: week, windows: [week, fable] }
  },
  { id: 'spare', label: 'Spare', usable: true, usage: { tightest: open, windows: [open] } }
]
const facts: AccountFacts = {
  accounts: () => accounts,
  selectedAccountId: () => 'default'
}

describe('the served launch picks its account for its model', () => {
  it('keeps the selected account for Opus and no model, skips it for Fable', () => {
    expect(accountForLaunch(facts, 'claude', 'claude-opus-5-5').id).toBe('default')
    expect(accountForLaunch(facts, 'claude').id).toBe('default')
    expect(accountForLaunch(facts, 'claude', 'claude-fable-5-1').id).toBe('spare')
  })
  it('resolves "any" and nothing through the same pick for the same model', () => {
    expect(resolveAccountRef(facts, 'claude', 'any', 'claude-fable-5-1').id).toBe('spare')
    expect(resolveAccountRef(facts, 'claude', undefined, 'claude-fable-5-1').id).toBe('spare')
    expect(resolveAccountRef(facts, 'claude', 'any', 'claude-opus-5-5').id).toBe('default')
    // A named account is an instruction, whatever its caps.
    expect(resolveAccountRef(facts, 'claude', 'Default', 'claude-fable-5-1').id).toBe('default')
  })
})
