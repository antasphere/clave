import { describe, it, expect } from 'vitest'
import {
  capName,
  capOutLabel,
  capStatus,
  capStatusLine,
  formatResetAt,
  headroomWindow,
  type CapWindow
} from './cap-status'
import { usageSummaryForModel, usageSummaryOf } from './usage-summary'
import type { AccountUsageSummary, PoolUsageWindow } from './account-pool'

/**
 * The headroom words on the SHARED shape of a read (`account-pool.ts`: no
 * `status`, no `label`), the one main and the daemon hold. They must read
 * exactly what the window's store says on its own shape
 * (`usage-store.test.ts`): the same fixtures, the same strings.
 */
const w = (over: Partial<PoolUsageWindow> & { kind: string }): PoolUsageWindow => ({
  scope: null,
  usedPercentage: 0,
  severity: null,
  resetsAt: null,
  ...over
})

const DAY = 86_400_000
const H = 3_600_000
const now = Date.UTC(2026, 10, 9, 12, 0, 0)
const overall = w({ kind: 'weekly_all', usedPercentage: 40, resetsAt: now + 2 * DAY + 5 * H })
const fable = w({
  kind: 'weekly_scoped',
  scope: 'Fable',
  usedPercentage: 100,
  severity: 'critical',
  resetsAt: now + 3 * DAY
})
const block = w({ kind: 'session', usedPercentage: 20, resetsAt: now + 2 * H })
const account = usageSummaryOf({ windows: [block, overall, fable] }) as AccountUsageSummary

describe('headroomWindow', () => {
  it('names the tightest cap of the view', () => {
    const busy = w({ kind: 'session', usedPercentage: 70 })
    const summary = usageSummaryOf({ windows: [busy, overall] })
    expect(headroomWindow(summary)).toBe(busy)
    expect(headroomWindow(account)).toBe(overall)
  })
  it('gives an open tie to the all-models weekly cap, and nothing before a read', () => {
    const tied = w({ kind: 'session', usedPercentage: 40 })
    expect(headroomWindow(usageSummaryOf({ windows: [tied, overall] }))).toBe(overall)
    expect(headroomWindow(undefined)).toBeNull()
  })
})

describe('capName', () => {
  it('reads the scope, else 5h, else Overall, else the label', () => {
    expect(capName(fable)).toBe('Fable')
    expect(capName(block)).toBe('5h')
    expect(capName(overall)).toBe('Overall')
    const other: CapWindow = { ...w({ kind: 'monthly' }), label: 'Monthly credits' }
    expect(capName(other)).toBe('Monthly credits')
    // A shared-shaped window with no label names its kind.
    expect(capName(w({ kind: 'monthly' }))).toBe('monthly')
  })
})

describe('capOutLabel', () => {
  it('names the cap and when it comes back, in or at', () => {
    expect(capOutLabel(fable, { now })).toBe('Fable out · back in 3d')
    expect(capOutLabel({ ...overall, usedPercentage: 100 }, { now })).toBe(
      'Overall out · back in 2d 5h'
    )
    expect(capOutLabel(block, { now, reset: 'at' })).toBe(
      `5h out · back ${formatResetAt(block.resetsAt)}`
    )
    expect(capOutLabel(block, { now, reset: 'at' })).not.toMatch(/back in /)
    expect(capOutLabel({ ...fable, resetsAt: null })).toBe('Fable out')
  })
})

describe('capStatus', () => {
  it('reads an exhausted session view as out, the family named', () => {
    const onFable = capStatus(usageSummaryForModel(account, 'claude-fable-5-1'), { now })!
    expect(onFable.exhausted).toBe(true)
    expect(onFable.stopping).toBe(fable)
    expect(onFable.out).toEqual(['Fable out · back in 3d'])
    expect(onFable.headroom).toBe('60% left · Overall')
  })
  it('reads the shared cap out, the one back last first, no headroom', () => {
    const blockOut = { ...block, usedPercentage: 100, severity: 'critical' }
    const weekOut = { ...overall, usedPercentage: 97, severity: 'warning' }
    const status = capStatus(usageSummaryOf({ windows: [blockOut, weekOut, fable] }), { now })!
    expect(status.stopping).toBe(weekOut)
    expect(status.exhausted).toBe(true)
    expect(status.headroom).toBeNull()
    expect(status.out).toEqual([
      'Overall out · back in 2d 5h',
      '5h out · back in 2h',
      'Fable out · back in 3d'
    ])
  })
  it('says nothing before a read, or on a read the caller marks failed', () => {
    expect(capStatus(undefined)).toBeNull()
    expect(capStatus({ status: 'error', tightest: null })).toBeNull()
  })
})

describe('capStatusLine', () => {
  it('reads the same one-line strings as the window', () => {
    expect(capStatusLine(account, { now })).toBe('60% left · Overall · Fable out · back in 3d')
    expect(capStatusLine(usageSummaryForModel(account, 'claude-opus-5-5'), { now })).toBe(
      '60% left · Overall'
    )
    const week = w({ kind: 'weekly_all', usedPercentage: 96, resetsAt: now + 4 * DAY })
    const busyBlock = w({ kind: 'session', usedPercentage: 50, severity: 'warning' })
    expect(capStatusLine(usageSummaryOf({ windows: [busyBlock, week] }), { now })).toBe(
      'Overall out · back in 4d'
    )
    expect(capStatusLine(usageSummaryOf({ windows: [fable] }), { now })).toBe(
      'Fable out · back in 3d'
    )
    const codexWeek = w({ kind: 'weekly_all', usedPercentage: 30 })
    const sparkBlock = w({
      kind: 'session',
      scope: 'Spark',
      usedPercentage: 100,
      severity: 'critical',
      resetsAt: now + 2 * H
    })
    const sparkWeek = w({
      kind: 'weekly_scoped',
      scope: 'Spark',
      usedPercentage: 99,
      resetsAt: now + 5 * DAY
    })
    expect(
      capStatusLine(usageSummaryOf({ windows: [codexWeek, sparkBlock, sparkWeek] }), { now })
    ).toBe('70% left · Overall · Spark out · back in 5d')
    expect(capStatusLine({ tightest: null })).toBeNull()
  })
})
