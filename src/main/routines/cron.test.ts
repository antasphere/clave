import { describe, expect, it } from 'vitest'
import {
  CronParseError,
  describeCron,
  lastOccurrence,
  matchesAt,
  nextOccurrence,
  occurrencesBetween,
  parseCron
} from './cron'

/** A local-time instant, the way the scheduler sees the machine's clock. */
const local = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

describe('parseCron', () => {
  it('reads every field shape: stars, lists, ranges, steps, names', () => {
    const s = parseCron('30 8 * * 1-5')
    expect([...s.minute.values]).toEqual([30])
    expect([...s.hour.values]).toEqual([8])
    expect(s.dayOfMonth.any).toBe(true)
    expect([...s.dayOfWeek.values]).toEqual([1, 2, 3, 4, 5])
    expect([...parseCron('*/15 * * * *').minute.values]).toEqual([0, 15, 30, 45])
    expect([...parseCron('0 9,17 * * *').hour.values]).toEqual([9, 17])
    expect([...parseCron('0 0 1 jan,jul *').month.values]).toEqual([1, 7])
    expect([...parseCron('0 0 * * mon-fri').dayOfWeek.values]).toEqual([1, 2, 3, 4, 5])
    expect([...parseCron('0 0 * * 7').dayOfWeek.values]).toEqual([0])
    expect([...parseCron('5/20 * * * *').minute.values]).toEqual([5, 25, 45])
  })

  it('refuses what it cannot read, naming the field', () => {
    expect(() => parseCron('30 8 * *')).toThrow(CronParseError)
    expect(() => parseCron('30 8 * *')).toThrow(/five fields/)
    expect(() => parseCron('60 8 * * *')).toThrow(/minute/)
    expect(() => parseCron('0 24 * * *')).toThrow(/hour/)
    expect(() => parseCron('0 0 0 * *')).toThrow(/day of month/)
    expect(() => parseCron('0 0 * 13 *')).toThrow(/month/)
    expect(() => parseCron('0 0 * * 8')).toThrow(/day of week/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/)
    expect(() => parseCron('a * * * *')).toThrow(/not a value/)
    expect(() => parseCron('@daily')).toThrow(CronParseError)
    expect(() => parseCron('0 0 * * *   extra')).toThrow(CronParseError)
  })
})

describe('matchesAt and nextOccurrence', () => {
  it('finds the next weekday 08:30 across a weekend', () => {
    const s = parseCron('30 8 * * 1-5')
    // Friday 6 November 2026, 09:00 → Monday 9 November 08:30.
    const friday = local(2026, 11, 6, 9, 0)
    expect(nextOccurrence(s, friday)).toBe(local(2026, 11, 9, 8, 30))
    expect(matchesAt(s, new Date(local(2026, 11, 9, 8, 30)))).toBe(true)
    expect(matchesAt(s, new Date(local(2026, 11, 7, 8, 30)))).toBe(false)
  })

  it('is strictly after: the occurrence at the instant itself is not next', () => {
    const s = parseCron('30 8 * * *')
    const at = local(2026, 11, 6, 8, 30)
    expect(nextOccurrence(s, at)).toBe(local(2026, 11, 7, 8, 30))
    expect(nextOccurrence(s, at - 1)).toBe(at)
  })

  it('applies cron day rule: both restricted means either matches', () => {
    // The 15th of the month, or a Monday.
    const s = parseCron('0 12 15 * 1')
    // Tuesday 10 November 2026 → Monday 16? No: the 15th (Sunday) comes first.
    expect(nextOccurrence(s, local(2026, 11, 10, 0, 0))).toBe(local(2026, 11, 15, 12, 0))
    expect(nextOccurrence(s, local(2026, 11, 15, 12, 0))).toBe(local(2026, 11, 16, 12, 0))
  })

  it('jumps months and years for a sparse schedule, and gives up past the horizon', () => {
    const s = parseCron('0 0 1 jan *')
    expect(nextOccurrence(s, local(2026, 11, 6, 0, 0))).toBe(local(2027, 1, 1, 0, 0))
    // 31 February never comes.
    expect(nextOccurrence(parseCron('0 0 31 2 *'), local(2026, 1, 1, 0, 0))).toBeNull()
  })

  it('lists every occurrence in a window, oldest first, and collapses nothing', () => {
    const s = parseCron('*/15 * * * *')
    const from = local(2026, 11, 6, 8, 0)
    const to = local(2026, 11, 6, 9, 0)
    expect(occurrencesBetween(s, from, to)).toEqual([
      local(2026, 11, 6, 8, 15),
      local(2026, 11, 6, 8, 30),
      local(2026, 11, 6, 8, 45),
      local(2026, 11, 6, 9, 0)
    ])
    expect(occurrencesBetween(s, from, from)).toEqual([])
  })

  it('steps through the Brussels clock changes by the machine clock', () => {
    // The test machine's zone decides the day's length; what must hold is that
    // a daily 03:00 is found exactly once per calendar day around both
    // changes of 2026 (29 March, 25 October), whatever the zone.
    const s = parseCron('0 3 * * *')
    for (const [y, m, d] of [
      [2026, 3, 28],
      [2026, 10, 24]
    ]) {
      const start = local(y, m, d, 0, 0)
      const found = occurrencesBetween(s, start, start + 3 * 86_400_000 + 3_600_000)
      const days = new Set(found.map((t) => new Date(t).getDate()))
      expect(days.size).toBe(found.length)
      expect(found.every((t) => new Date(t).getHours() === 3)).toBe(true)
    }
  })
})

describe('describeCron', () => {
  it('names the common shapes and quotes the rest', () => {
    expect(describeCron('30 8 * * 1-5')).toBe('weekdays at 08:30')
    expect(describeCron('0 9 * * *')).toBe('every day at 09:00')
    expect(describeCron('0 10 * * 0,6')).toBe('weekends at 10:00')
    expect(describeCron('15 7 * * mon')).toBe('every Mon at 07:15')
    expect(describeCron('0 0 1 * *')).toBe('on the 1st of every month at 00:00')
    expect(describeCron('*/15 * * * *')).toBe('every 15 minutes')
    expect(describeCron('*/2 * * * *')).toBe('every 2 minutes')
    expect(describeCron('* * * * *')).toBe('every minute')
    expect(describeCron('*/15 * * * 1-5')).toBe('weekdays every 15 minutes')
    expect(describeCron('0 */2 * * *')).toBe('every 2 hours')
    expect(describeCron('0,7 * * * *')).toBe('"0,7 * * * *"')
    expect(describeCron('not cron')).toBe('"not cron"')
  })
})

describe('malformed tokens (round 1, F7)', () => {
  it('refuses what is neither digits nor a month or weekday name', () => {
    for (const bad of [
      '/2 * * * *',
      '-5 * * * *',
      '0x5 * * * *',
      '1e1 * * * *',
      '* * * * fried',
      '1//2 * * * *',
      '* * * * fr'
    ]) {
      expect(() => parseCron(bad), bad).toThrow(CronParseError)
    }
    expect([...parseCron('* * * * friday').dayOfWeek.values]).toEqual([5])
    expect([...parseCron('0 0 1 january *').month.values]).toEqual([1])
    expect([...parseCron('05 * * * *').minute.values]).toEqual([5])
  })
})

describe('lastOccurrence (round 1, F8)', () => {
  it('names the latest occurrence at or before an instant, for a dense and a sparse schedule', () => {
    const minutely = parseCron('* * * * *')
    const at = local(2026, 11, 6, 9, 0) + 30_000
    expect(lastOccurrence(minutely, at)).toBe(local(2026, 11, 6, 9, 0))
    const yearly = parseCron('0 0 1 jan *')
    expect(lastOccurrence(yearly, local(2026, 11, 6, 9, 0))).toBe(local(2026, 1, 1, 0, 0))
    expect(lastOccurrence(parseCron('0 0 31 2 *'), local(2026, 11, 6, 9, 0))).toBeNull()
  })
})

describe('ranges with a third segment and malformed steps (round 2, F7)', () => {
  it('refuses 1-3-5, mon-fri-foo and a step that is not digits', () => {
    for (const bad of ['1-3-5 * * * *', '* * * * mon-fri-foo', '*/0x2 * * * *', '1-5/x * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(CronParseError)
    }
  })
})
