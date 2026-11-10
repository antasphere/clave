import { describe, it, expect } from 'vitest'
import { modelRungFor, resolveLimitScope } from './limit-scope'
import type { AccountUsageSummary, PoolUsageWindow } from '../../../shared/account-pool'
import { usageSummaryForModel, usageSummaryOf } from '../../../shared/usage-summary'

/**
 * Which cap stopped the tab, and which model is the way on (PRDCT-4302). A
 * family read as the account's sends the tab off a subscription it could
 * still use; the wrong model rung spends the scarce week or lands on a cap
 * that is out too.
 */
const w = (over: Partial<PoolUsageWindow>): PoolUsageWindow => ({
  kind: 'weekly_all',
  scope: null,
  usedPercentage: 40,
  severity: 'normal',
  resetsAt: 1_000,
  ...over
})
const fableOut = w({
  kind: 'weekly_scoped',
  scope: 'Fable',
  usedPercentage: 100,
  severity: 'critical'
})
const opusOut = w({ kind: 'weekly_scoped', scope: 'Opus', usedPercentage: 97 })
const week = w({ kind: 'weekly_all', usedPercentage: 40 })
const weekOut = w({ kind: 'weekly_all', usedPercentage: 100, severity: 'critical' })
/** A session view: `tightest` over the shared caps and the session's family. */
const view = (
  tightest: PoolUsageWindow | null,
  windows: PoolUsageWindow[],
  shared?: PoolUsageWindow | null
): AccountUsageSummary => ({
  tightest,
  windows,
  ...(shared !== undefined ? { shared } : {})
})
const blockOutSoon = w({
  kind: 'session',
  usedPercentage: 100,
  severity: 'critical',
  resetsAt: 2 * 3_600_000
})
const fableOutLater = w({
  kind: 'weekly_scoped',
  scope: 'Fable',
  usedPercentage: 100,
  severity: 'critical',
  resetsAt: 4 * 86_400_000
})
/** The session view the product builds: the split's own `tightest` and `shared`. */
const realView = (windows: PoolUsageWindow[], model: string): AccountUsageSummary =>
  usageSummaryForModel(usageSummaryOf({ windows }), model) as AccountUsageSummary
/** An account view: every family under `scoped`. */
const account = (...out: string[]): AccountUsageSummary => ({
  tightest: week,
  windows: [week],
  scoped: ['Fable', 'Opus', 'Sonnet'].map((family) => ({
    family,
    window: w({
      kind: 'weekly_scoped',
      scope: family,
      usedPercentage: out.includes(family) ? 100 : 20
    }),
    exhausted: out.includes(family)
  }))
})

describe('resolveLimitScope', () => {
  it('takes the family the report names while the shared caps are open, and the credits whatever the read says', () => {
    expect(resolveLimitScope({ scope: { family: 'Opus' } }, view(week, [week, opusOut]))).toEqual({
      family: 'Opus'
    })
    expect(resolveLimitScope({ scope: { family: 'Opus' } }, undefined)).toEqual({ family: 'Opus' })
    // The CLI named the Fable week, and the 5-hour block is out too: the
    // account's, since Opus would hit the block (round 2, F2b).
    expect(
      resolveLimitScope(
        { scope: { family: 'Fable' } },
        realView([blockOutSoon, week, fableOutLater], 'claude-fable-5-1')
      )
    ).toBe('shared')
    expect(
      resolveLimitScope({ scope: { family: 'Opus' } }, view(weekOut, [weekOut], weekOut))
    ).toBe('shared')
    expect(resolveLimitScope({ scope: 'credits' }, view(fableOut, [week, fableOut]))).toBe(
      'credits'
    )
    expect(resolveLimitScope({ scope: 'credits' }, undefined)).toBe('credits')
  })

  it("settles a shared or unnamed report against the session's own read: its family cap out while the week is open is the family's", () => {
    // The CLI typed the Fable rejection as a plain week.
    expect(resolveLimitScope({ scope: 'shared' }, view(fableOut, [week, fableOut]))).toEqual({
      family: 'Fable'
    })
    expect(resolveLimitScope({ scope: 'unknown' }, view(fableOut, [week, fableOut]))).toEqual({
      family: 'Fable'
    })
    // The week itself is out: the account's.
    expect(resolveLimitScope({ scope: 'shared' }, view(weekOut, [weekOut, fableOut]))).toBe(
      'shared'
    )
    expect(resolveLimitScope({ scope: 'unknown' }, view(weekOut, [weekOut]))).toBe('shared')
  })

  it("reads the account's when a shared cap is out too, even when the family's cap comes back later (round 1, F2)", () => {
    // The 5-hour block out for two hours, the Fable week out for four days:
    // the one rule puts Fable on top of the session view, and a model of
    // another family would still hit the block.
    const both = realView([blockOutSoon, week, fableOutLater], 'claude-fable-5-1')
    expect(both.tightest?.scope).toBe('Fable')
    expect(resolveLimitScope({ scope: 'shared' }, both)).toBe('shared')
    expect(resolveLimitScope({ scope: 'unknown' }, both)).toBe('shared')
    expect(resolveLimitScope(null, both)).toBe('shared')
    // The same read with the block open again: the family's.
    expect(
      resolveLimitScope({ scope: 'shared' }, realView([week, fableOutLater], 'claude-fable-5-1'))
    ).toEqual({ family: 'Fable' })
    // Hand-built views say the same, and a summary from before the split,
    // with no `shared`, reads as it did.
    expect(
      resolveLimitScope(
        { scope: 'shared' },
        view(fableOutLater, [blockOutSoon, week, fableOutLater], blockOutSoon)
      )
    ).toBe('shared')
    expect(resolveLimitScope({ scope: 'shared' }, view(fableOut, [week, fableOut]))).toEqual({
      family: 'Fable'
    })
  })

  it('reads the poll alone the same way when there is no report', () => {
    expect(resolveLimitScope(null, view(fableOut, [week, fableOut]))).toEqual({ family: 'Fable' })
    expect(resolveLimitScope(undefined, view(weekOut, [weekOut]))).toBe('shared')
  })

  it('falls to the account rung when the read shows nothing out, or there is no read', () => {
    expect(resolveLimitScope({ scope: 'shared' }, view(week, [week, opusOut]))).toBe('shared')
    expect(resolveLimitScope({ scope: 'unknown' }, undefined)).toBe('shared')
    expect(resolveLimitScope({ scope: 'shared' }, view(null, []))).toBe('shared')
  })
})

describe('modelRungFor', () => {
  it('descends: Fable out offers Opus 5.5, Opus out offers Sonnet 5.5, Sonnet out offers Haiku', () => {
    expect(modelRungFor('Fable', account('Fable'))).toBe('claude-opus-5-5')
    expect(modelRungFor('Opus', account('Opus'))).toBe('claude-sonnet-5-5')
    expect(modelRungFor('Sonnet', account('Sonnet'))).toBe('claude-haiku-4-5-20251001')
  })

  it('never steps up: Opus out with Fable open still offers Sonnet', () => {
    expect(modelRungFor('Opus', account('Opus'))).toBe('claude-sonnet-5-5')
    expect(modelRungFor('opus', account())).toBe('claude-sonnet-5-5')
  })

  it('skips a family whose cap the account read shows out, and a family the read does not name is open', () => {
    expect(modelRungFor('Fable', account('Fable', 'Opus'))).toBe('claude-sonnet-5-5')
    expect(modelRungFor('Fable', account('Fable', 'Opus', 'Sonnet'))).toBe(
      'claude-haiku-4-5-20251001'
    )
    // No read yet: the next family down.
    expect(modelRungFor('Fable', undefined)).toBe('claude-opus-5-5')
  })

  it('is nothing for a family outside the descent, or at its bottom', () => {
    expect(modelRungFor('Spark', account())).toBeNull()
    expect(modelRungFor('Haiku', account())).toBeNull()
    expect(modelRungFor('', account())).toBeNull()
  })
})
