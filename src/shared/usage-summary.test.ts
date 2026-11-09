import { describe, it, expect } from 'vitest'
import {
  familyOfModel,
  usageSummaryForModel,
  usageSummaryOf,
  usageWindowsForModel,
  scopedCapsOf
} from './usage-summary'
import { isExhausted, type PoolUsageWindow } from './account-pool'

/**
 * The split of a read into shared caps and family caps (PRDCT-4253). A
 * wrong split is silent: the account reads "at limit" with most of its week
 * left, or a launch lands on a subscription whose family cap is spent.
 */
const w = (over: Partial<PoolUsageWindow> & { kind: string }): PoolUsageWindow => ({
  scope: null,
  usedPercentage: 0,
  severity: null,
  resetsAt: null,
  ...over
})

// An account with the week at 40% and its Fable cap spent: the shape Romain
// saw on 9 November 2026.
const session = w({ kind: 'session', usedPercentage: 20, resetsAt: 1_000 })
const overall = w({ kind: 'weekly_all', usedPercentage: 40, resetsAt: 5_000 })
const fable = w({
  kind: 'weekly_scoped',
  scope: 'Fable',
  usedPercentage: 100,
  severity: 'critical',
  resetsAt: 3_000
})
const opus = w({ kind: 'weekly_scoped', scope: 'Opus', usedPercentage: 10, resetsAt: 5_000 })
const read = { windows: [session, overall, fable, opus] }

describe('usageSummaryOf, the account view', () => {
  it('takes the tightest SHARED cap, never a family cap, and lists the family that is out', () => {
    const summary = usageSummaryOf(read)!
    expect(summary.tightest).toBe(overall)
    expect(summary.shared).toBe(overall)
    expect(summary.scopedOut).toEqual(['Fable'])
    expect(summary.scoped?.map((c) => [c.family, c.exhausted])).toEqual([
      ['Fable', true],
      ['Opus', false]
    ])
    expect(summary.windows).toHaveLength(4)
    expect(isExhausted(summary)).toBe(false)
  })
  it('is exhausted by a shared cap alone', () => {
    const spent = usageSummaryOf({ windows: [{ ...overall, usedPercentage: 96 }, opus] })!
    expect(isExhausted(spent)).toBe(true)
    expect(spent.scopedOut).toEqual([])
  })
  it('has no tightest when the read names only family caps', () => {
    // A read with no shared cap at all: nothing stops the account as a whole.
    const summary = usageSummaryOf({ windows: [fable] })!
    expect(summary.tightest).toBeNull()
    expect(summary.scopedOut).toEqual(['Fable'])
    expect(isExhausted(summary)).toBe(false)
  })
  it('is nothing for no read or a failed one', () => {
    expect(usageSummaryOf(undefined)).toBeUndefined()
    expect(usageSummaryOf({})).toBeUndefined()
  })
})

describe('usageSummaryForModel, the session view', () => {
  const account = usageSummaryOf(read)
  it('is NOT exhausted for a session on Opus, and IS for a session on Fable', () => {
    const onOpus = usageSummaryForModel(account, 'claude-opus-5-5')!
    expect(onOpus.tightest).toBe(overall)
    expect(onOpus.windows).toEqual([session, overall, opus])
    expect(onOpus.scopedOut).toEqual([])
    expect(isExhausted(onOpus)).toBe(false)
    const onFable = usageSummaryForModel(account, 'claude-fable-5-1')!
    expect(onFable.tightest).toBe(fable)
    expect(onFable.shared).toBe(overall)
    expect(onFable.windows).toEqual([session, overall, fable])
    expect(onFable.scopedOut).toEqual(['Fable'])
    expect(isExhausted(onFable)).toBe(true)
  })
  it('keeps the shared caps alone with no model, or a model of no listed family', () => {
    for (const model of [undefined, '', 'default', 'sonnet', 'notfable']) {
      const view = usageSummaryForModel(account, model)!
      expect(view.windows).toEqual([session, overall])
      expect(view.tightest).toBe(overall)
      expect(view.scoped).toEqual([])
    }
  })
  it('matches the family by the model id’s own tokens, whatever the case', () => {
    expect(familyOfModel(read.windows, 'FABLE')).toBe('Fable')
    expect(familyOfModel(read.windows, 'claude-fable-5[1m]')).toBe('Fable')
    expect(familyOfModel(read.windows, 'opus')).toBe('Opus')
    expect(familyOfModel(read.windows, 'sonnet')).toBeNull()
    expect(usageWindowsForModel(read.windows, 'fable')).toEqual([session, overall, fable])
  })
  it('is nothing for no summary', () => {
    expect(usageSummaryForModel(undefined, 'fable')).toBeUndefined()
  })
})

describe('scopedCapsOf', () => {
  it('keeps the tighter of two windows the read carries for one family', () => {
    const loose = w({ kind: 'weekly_scoped', scope: 'Fable', usedPercentage: 30 })
    const caps = scopedCapsOf([loose, fable])
    expect(caps).toHaveLength(1)
    expect(caps[0].window).toBe(fable)
    expect(caps[0].exhausted).toBe(true)
  })
  it('skips a scoped window with no family name', () => {
    expect(scopedCapsOf([w({ kind: 'weekly_scoped', scope: ' ' })])).toEqual([])
  })
})
