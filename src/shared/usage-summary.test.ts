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
    // An alias with the context marker glued on: the split is on every
    // non-alphanumeric run, not on dashes alone.
    expect(familyOfModel(read.windows, 'fable[1m]')).toBe('Fable')
    expect(familyOfModel(read.windows, 'opus[1m]')).toBe('Opus')
    expect(familyOfModel(read.windows, 'opus')).toBe('Opus')
    expect(familyOfModel(read.windows, 'sonnet')).toBeNull()
    expect(usageWindowsForModel(read.windows, 'fable')).toEqual([session, overall, fable])
  })
  it('is nothing for no summary', () => {
    expect(usageSummaryForModel(undefined, 'fable')).toBeUndefined()
  })
})

describe('a family is any window with a scope, whatever its kind', () => {
  // Codex's Spark bucket: a 5-hour block AND a weekly cap of its own, both
  // scoped Spark, beside the account's weekly all-models cap.
  const codexWeek = w({ kind: 'weekly_all', usedPercentage: 30 })
  const sparkBlock = w({
    kind: 'session',
    scope: 'Spark',
    usedPercentage: 100,
    severity: 'critical'
  })
  const sparkWeek = w({ kind: 'weekly_scoped', scope: 'Spark', usedPercentage: 20 })
  it('keeps a Codex account open when only its Spark block is out, and names Spark', () => {
    const account = usageSummaryOf({ windows: [codexWeek, sparkBlock, sparkWeek] })!
    expect(account.tightest).toBe(codexWeek)
    expect(isExhausted(account)).toBe(false)
    expect(account.scopedOut).toEqual(['Spark'])
    // The tighter of the two Spark windows stands for the family.
    expect(account.scoped?.[0].window).toBe(sparkBlock)
  })
  it('is out for a Codex session on a Spark model, open for one on another model', () => {
    const account = usageSummaryOf({ windows: [codexWeek, sparkBlock, sparkWeek] })
    const onSpark = usageSummaryForModel(account, 'gpt-5.3-codex-spark')!
    expect(onSpark.tightest).toBe(sparkBlock)
    expect(isExhausted(onSpark)).toBe(true)
    const onCodex = usageSummaryForModel(account, 'gpt-5.3-codex')!
    expect(onCodex.windows).toEqual([codexWeek])
    expect(isExhausted(onCodex)).toBe(false)
  })
  it('treats a scoped kind with no name as shared: it stops every model', () => {
    const nameless = w({
      kind: 'weekly_scoped',
      scope: null,
      usedPercentage: 100,
      severity: 'critical'
    })
    const account = usageSummaryOf({ windows: [overall, nameless] })!
    expect(account.tightest).toBe(nameless)
    expect(isExhausted(account)).toBe(true)
    expect(account.scoped).toEqual([])
    expect(usageSummaryForModel(account, 'opus')!.windows).toEqual([overall, nameless])
  })
  it('matches a family whose scope carries stray spaces', () => {
    const padded = { ...fable, scope: ' Fable ' }
    const account = usageSummaryOf({ windows: [overall, padded] })
    expect(account!.scopedOut).toEqual(['Fable'])
    const onFable = usageSummaryForModel(account, 'claude-fable-5-1')!
    expect(onFable.windows).toEqual([overall, padded])
    expect(isExhausted(onFable)).toBe(true)
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
