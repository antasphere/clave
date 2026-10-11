// The clock-change days, in Brussels: the zone is set before any Date exists
// in this worker (Node reads TZ at the first use of a Date), so the fixture
// holds wherever the suite runs.
process.env.TZ = 'Europe/Brussels'
import { describe, expect, it } from 'vitest'
import type { ActivityRow } from './activity-model'
import { foldActivity } from './activity-fold'

const row = (partial: Partial<ActivityRow> & Pick<ActivityRow, 'ts' | 'kind'>): ActivityRow => ({
  v: 1,
  ...partial
})

describe('the clock-change days in Brussels', () => {
  it('runs in the Brussels zone', () => {
    expect(new Date(2026, 9, 25, 12).getTimezoneOffset()).toBe(-60)
    expect(new Date(2026, 9, 24, 12).getTimezoneOffset()).toBe(-120)
  })

  it('the clocks go back: an hour of work across the repeated hour is an hour, counted once', () => {
    // 01:30 CEST is 23:30 UTC on the 24th; 02:30 CET is 01:30 UTC on the 25th: 120 real minutes.
    const rows = [
      row({ kind: 'open', id: 'a', ts: '2026-10-24T23:00:00.000Z', provider: 'claude' }),
      row({ kind: 'state', id: 'a', ts: '2026-10-24T23:30:00.000Z', state: 'working' }),
      row({ kind: 'state', id: 'a', ts: '2026-10-25T01:30:00.000Z', state: 'idle' }),
      row({ kind: 'close', id: 'a', ts: '2026-10-25T02:00:00.000Z' })
    ]
    const [day] = foldActivity(rows, '2026-10-25', '2026-10-25', Date.parse('2026-10-25T12:00:00Z'))
    expect(day.sessions[0].workingMin).toBe(120)
    expect(day.totals.agentMin).toBe(120)
    // The repeated hour lands on the same cells twice, once per session.
    expect(day.totals.peak).toBe(1)
    expect(day.working[150]).toBe(1)
    expect(day.totals.coverageMin).toBe(90)
    expect(day.totals.openMin).toBe(120)
    expect(day.sessions[0].open).toEqual([60, 180])
  })

  it('the clocks go forward: the missing hour leaves its cells empty and the work keeps its length', () => {
    // 01:30 CET is 00:30 UTC; 03:30 CEST is 01:30 UTC: 60 real minutes.
    const rows = [
      row({ kind: 'open', id: 'a', ts: '2026-03-29T00:00:00.000Z', provider: 'claude' }),
      row({ kind: 'state', id: 'a', ts: '2026-03-29T00:30:00.000Z', state: 'working' }),
      row({ kind: 'state', id: 'a', ts: '2026-03-29T01:30:00.000Z', state: 'idle' })
    ]
    const [day] = foldActivity(rows, '2026-03-29', '2026-03-29', Date.parse('2026-03-29T12:00:00Z'))
    expect(day.sessions[0].workingMin).toBe(60)
    expect(day.totals.agentMin).toBe(60)
    expect(day.totals.coverageMin).toBe(60)
    expect(day.working[120]).toBe(0)
    expect(day.working[90]).toBe(1)
    expect(day.working[200]).toBe(1)
    expect(day.sessions[0].working).toEqual([[90, 210]])
  })

  it('the 25th hour stays on the tape', () => {
    const rows = [
      row({ kind: 'open', id: 'a', ts: '2026-10-25T22:00:00.000Z', provider: 'claude' }),
      row({ kind: 'state', id: 'a', ts: '2026-10-25T22:30:00.000Z', state: 'working' }),
      row({ kind: 'state', id: 'a', ts: '2026-10-25T22:59:00.000Z', state: 'idle' })
    ]
    const [day] = foldActivity(rows, '2026-10-25', '2026-10-25', Date.parse('2026-10-26T12:00:00Z'))
    expect(day.totals.coverageMin).toBe(29)
    expect(day.totals.agentMin).toBe(29)
    expect(day.sessions[0].working).toEqual([[1410, 1439]])
  })
})
