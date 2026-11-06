import { describe, expect, it } from 'vitest'
import { ON_TIME_MS, decideTick, nextRunAt } from './scheduler'

const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0): number =>
  new Date(y, mo - 1, d, h, mi, s, 0).getTime()

const WEEKDAYS_0830 = '30 8 * * 1-5'
const base = {
  schedule: WEEKDAYS_0830,
  catchUp: true,
  invalid: null,
  running: false
}

describe('decideTick', () => {
  it('starts the clock on a routine never seen, catching up nothing from before', () => {
    const now = local(2026, 11, 6, 8, 31)
    expect(decideTick({ ...base, clock: { lastConsideredAt: null, schedule: null }, now })).toEqual(
      { kind: 'reset' }
    )
  })

  it('resets the clock when the schedule changed, so the new one catches up nothing', () => {
    const now = local(2026, 11, 6, 8, 31)
    expect(
      decideTick({
        ...base,
        clock: { lastConsideredAt: now - 3_600_000, schedule: '0 7 * * *' },
        now
      })
    ).toEqual({ kind: 'reset' })
  })

  it('is idle while no occurrence fell in the window', () => {
    const now = local(2026, 11, 6, 8, 29, 50)
    expect(
      decideTick({
        ...base,
        clock: { lastConsideredAt: now - 30_000, schedule: WEEKDAYS_0830 },
        now
      })
    ).toEqual({ kind: 'idle' })
  })

  it('runs on time when the occurrence is under 90 seconds old', () => {
    const occurrence = local(2026, 11, 6, 8, 30)
    const now = occurrence + 20_000
    expect(
      decideTick({
        ...base,
        clock: { lastConsideredAt: now - 30_000, schedule: WEEKDAYS_0830 },
        now
      })
    ).toEqual({ kind: 'run', occurrence, trigger: 'scheduled', collapsed: [occurrence] })
  })

  it('collapses N missed occurrences into ONE catch-up run, named by the latest', () => {
    // Asleep from Monday 07:00 to Thursday 10:00: three weekday mornings missed.
    const last = local(2026, 11, 2, 7, 0)
    const now = local(2026, 11, 5, 10, 0)
    const decision = decideTick({
      ...base,
      clock: { lastConsideredAt: last, schedule: WEEKDAYS_0830 },
      now
    })
    expect(decision.kind).toBe('run')
    if (decision.kind !== 'run') return
    expect(decision.trigger).toBe('catch-up')
    expect(decision.occurrence).toBe(local(2026, 11, 5, 8, 30))
    expect(decision.collapsed).toEqual([
      local(2026, 11, 2, 8, 30),
      local(2026, 11, 3, 8, 30),
      local(2026, 11, 4, 8, 30),
      local(2026, 11, 5, 8, 30)
    ])
  })

  it('is a catch-up exactly at the 90 second edge, on time just under it', () => {
    const occurrence = local(2026, 11, 6, 8, 30)
    const clock = { lastConsideredAt: occurrence - 30_000, schedule: WEEKDAYS_0830 }
    expect(decideTick({ ...base, clock, now: occurrence + ON_TIME_MS - 1 })).toMatchObject({
      trigger: 'scheduled'
    })
    expect(decideTick({ ...base, clock, now: occurrence + ON_TIME_MS })).toMatchObject({
      trigger: 'catch-up'
    })
  })

  it('skips a late occurrence when catch-up is off, and still runs an on-time one', () => {
    const occurrence = local(2026, 11, 6, 8, 30)
    const clock = { lastConsideredAt: occurrence - 30_000, schedule: WEEKDAYS_0830 }
    expect(decideTick({ ...base, catchUp: false, clock, now: occurrence + 3_600_000 })).toEqual({
      kind: 'skip',
      occurrence,
      reason: 'catch-up-off'
    })
    expect(decideTick({ ...base, catchUp: false, clock, now: occurrence + 10_000 })).toMatchObject({
      kind: 'run',
      trigger: 'scheduled'
    })
  })

  it('skips the occurrence while a run is in flight', () => {
    const occurrence = local(2026, 11, 6, 8, 30)
    expect(
      decideTick({
        ...base,
        running: true,
        clock: { lastConsideredAt: occurrence - 30_000, schedule: WEEKDAYS_0830 },
        now: occurrence + 10_000
      })
    ).toEqual({ kind: 'skip', occurrence, reason: 'running' })
  })

  it('fails a due occurrence of a routine that cannot run, with its reason', () => {
    const occurrence = local(2026, 11, 6, 8, 30)
    expect(
      decideTick({
        ...base,
        invalid: 'team scope is not built yet',
        clock: { lastConsideredAt: occurrence - 30_000, schedule: WEEKDAYS_0830 },
        now: occurrence + 10_000
      })
    ).toEqual({ kind: 'fail', occurrence, reason: 'team scope is not built yet' })
    expect(
      decideTick({
        ...base,
        invalid: 'team scope is not built yet',
        clock: { lastConsideredAt: occurrence - 30_000, schedule: WEEKDAYS_0830 },
        now: occurrence - 10_000
      })
    ).toEqual({ kind: 'idle' })
  })

  it('reads a gap in the ticks (a sleep) as the occurrences it covers, no power event needed', () => {
    // The last tick was Friday 23:59; the machine wakes Monday 09:00.
    const last = local(2026, 11, 6, 23, 59)
    const now = local(2026, 11, 9, 9, 0)
    const decision = decideTick({
      ...base,
      clock: { lastConsideredAt: last, schedule: WEEKDAYS_0830 },
      now
    })
    expect(decision).toMatchObject({
      kind: 'run',
      trigger: 'catch-up',
      occurrence: local(2026, 11, 9, 8, 30),
      collapsed: [local(2026, 11, 9, 8, 30)]
    })
  })
})

describe('nextRunAt', () => {
  it('names the next occurrence, null for a routine that cannot run', () => {
    const now = local(2026, 11, 6, 9, 0)
    expect(nextRunAt(WEEKDAYS_0830, null, now)).toBe(local(2026, 11, 9, 8, 30))
    expect(nextRunAt(WEEKDAYS_0830, 'team scope is not built yet', now)).toBeNull()
    expect(nextRunAt('not cron', null, now)).toBeNull()
  })
})
