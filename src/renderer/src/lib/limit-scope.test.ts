import { describe, it, expect } from 'vitest'
import { modelRungFor, resolveLimitScope } from './limit-scope'
import type { AccountUsageSummary, PoolUsageWindow } from '../../../shared/account-pool'

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
  windows: PoolUsageWindow[]
): AccountUsageSummary => ({
  tightest,
  windows
})
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
  it('takes the family the report names, and the credits, whatever the read says', () => {
    expect(resolveLimitScope({ scope: { family: 'Opus' } }, view(weekOut, [weekOut]))).toEqual({
      family: 'Opus'
    })
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
