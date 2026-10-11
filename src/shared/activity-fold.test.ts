import { describe, expect, it } from 'vitest'
import type { ActivityRow } from './activity-model'
import { normalizeActivityRow } from './activity-model'
import {
  dayRange,
  daysBack,
  foldActivity,
  localDayKey,
  minuteOfDay,
  spansFromRows
} from './activity-fold'

// All times are built with the local Date constructor, so the expectations hold
// in whatever zone the test runs: `at(h, m)` is that clock time on the 11th.
const at = (h: number, m: number, s = 0, day = 11): string =>
  new Date(2026, 9, day, h, m, s).toISOString()
const DAY = '2026-10-11'
const row = (partial: Partial<ActivityRow> & Pick<ActivityRow, 'ts' | 'kind'>): ActivityRow => ({
  v: 1,
  ...partial
})
const open = (id: string, ts: string, provider = 'claude'): ActivityRow =>
  row({ kind: 'open', id, ts, provider, cwd: `/p/${id}`, name: id, model: null })
const state = (id: string, ts: string, s: ActivityRow['state']): ActivityRow =>
  row({ kind: 'state', id, ts, state: s })
const close = (id: string, ts: string): ActivityRow => row({ kind: 'close', id, ts })

const NOW = new Date(2026, 9, 11, 23, 0).getTime()

describe('spansFromRows', () => {
  it('turns working/idle words into bursts and a close into the span end', () => {
    const rows = [
      open('a', at(10, 0)),
      state('a', at(10, 0, 30), 'working'),
      state('a', at(10, 2), 'idle'),
      state('a', at(10, 5), 'working'),
      state('a', at(10, 6), 'done'),
      close('a', at(10, 10))
    ]
    const { spans } = spansFromRows(rows, NOW)
    expect(spans).toHaveLength(1)
    const [s] = spans
    expect(s.close).toBe(Date.parse(at(10, 10)))
    expect(s.working).toEqual([
      [Date.parse(at(10, 0, 30)), Date.parse(at(10, 2))],
      [Date.parse(at(10, 5)), Date.parse(at(10, 6))]
    ])
  })

  it('a blocked wait ends the burst and starts a wait; working ends the wait', () => {
    const rows = [
      open('a', at(9, 0)),
      state('a', at(9, 0), 'working'),
      state('a', at(9, 3), 'blocked'),
      state('a', at(9, 8), 'working'),
      state('a', at(9, 9), 'idle')
    ]
    const { spans } = spansFromRows(rows, NOW)
    expect(spans[0].working).toEqual([
      [Date.parse(at(9, 0)), Date.parse(at(9, 3))],
      [Date.parse(at(9, 8)), Date.parse(at(9, 9))]
    ])
    expect(spans[0].blocked).toEqual([[Date.parse(at(9, 3)), Date.parse(at(9, 8))]])
    expect(spans[0].close).toBeNull()
  })

  it('an app quit closes every open span and burst at that moment', () => {
    const rows = [
      row({ kind: 'app', app: 'start', ts: at(8, 0) }),
      open('a', at(8, 1)),
      state('a', at(8, 2), 'working'),
      open('b', at(8, 3), 'terminal'),
      row({ kind: 'app', app: 'quit', ts: at(8, 30) }),
      row({ kind: 'app', app: 'start', ts: at(9, 0) })
    ]
    const { spans, app } = spansFromRows(rows, NOW)
    expect(spans.map((s) => s.close)).toEqual([Date.parse(at(8, 30)), Date.parse(at(8, 30))])
    expect(spans[0].working).toEqual([[Date.parse(at(8, 2)), Date.parse(at(8, 30))]])
    expect(app).toEqual([
      [Date.parse(at(8, 0)), Date.parse(at(8, 30))],
      [Date.parse(at(9, 0)), NOW]
    ])
  })

  it('a working burst that never got its idle word is cut at six hours', () => {
    const rows = [
      open('a', at(1, 0, 0, 10)),
      state('a', at(1, 0, 0, 10), 'working'),
      close('a', at(20, 0, 0, 11))
    ]
    const { spans } = spansFromRows(rows, NOW)
    expect(spans[0].working).toEqual([[Date.parse(at(1, 0, 0, 10)), Date.parse(at(7, 0, 0, 10))]])
    expect(spans[0].close).toBe(Date.parse(at(20, 0, 0, 11)))
    const live = spansFromRows(
      [open('b', at(1, 0, 0, 10)), state('b', at(1, 0, 0, 10), 'working')],
      NOW
    )
    expect(live.spans[0].working).toEqual([
      [Date.parse(at(1, 0, 0, 10)), Date.parse(at(7, 0, 0, 10))]
    ])
  })

  it('the same id opened again is one session with two open stretches', () => {
    const rows = [
      open('a', at(9, 0)),
      state('a', at(9, 0), 'working'),
      state('a', at(9, 10), 'idle'),
      close('a', at(9, 30)),
      open('a', at(10, 0)),
      state('a', at(10, 0), 'working'),
      state('a', at(10, 5), 'idle')
    ]
    const { spans } = spansFromRows(rows, NOW)
    expect(spans).toHaveLength(1)
    expect(spans[0].opens).toEqual([
      [Date.parse(at(9, 0)), Date.parse(at(9, 30))],
      [Date.parse(at(10, 0)), NOW]
    ])
    expect(spans[0].close).toBeNull()
    expect(spans[0].working).toHaveLength(2)
    const [day] = foldActivity(rows, DAY, DAY, NOW)
    expect(day.sessions).toHaveLength(1)
    expect(day.totals.sessionsOpened).toBe(1)
    expect(day.sessions[0].opens).toEqual([
      [540, 570],
      [600, 23 * 60]
    ])
    expect(day.sessions[0].open).toEqual([540, 23 * 60])
    expect(day.totals.openMin).toBe(30 + 13 * 60)
  })

  it('an untracked provider keeps its span and ignores state words', () => {
    const rows = [open('t', at(8, 0), 'pi'), state('t', at(8, 1), 'working')]
    const { spans } = spansFromRows(rows, NOW)
    expect(spans[0].tracked).toBe(false)
    expect(spans[0].working).toEqual([])
  })

  it('a session still working at now is cut at now and stays live', () => {
    const rows = [open('a', at(22, 0)), state('a', at(22, 30), 'working')]
    const { spans } = spansFromRows(rows, NOW)
    expect(spans[0].working).toEqual([[Date.parse(at(22, 30)), NOW]])
    expect(spans[0].close).toBeNull()
  })

  it('rows after now, duplicate opens and states of unknown sessions are ignored', () => {
    const rows = [
      state('ghost', at(8, 0), 'working'),
      open('a', at(8, 0)),
      open('a', at(8, 5)),
      state('a', at(23, 30), 'working')
    ]
    const { spans } = spansFromRows(rows, NOW)
    expect(spans).toHaveLength(1)
    expect(spans[0].open).toBe(Date.parse(at(8, 0)))
    expect(spans[0].working).toEqual([])
  })
})

describe('foldActivity', () => {
  it('counts coverage, concurrency and agent minutes on exact cells', () => {
    const rows = [
      open('a', at(10, 0)),
      state('a', at(10, 0), 'working'),
      state('a', at(10, 10), 'idle'),
      open('b', at(10, 5)),
      state('b', at(10, 5), 'working'),
      state('b', at(10, 20), 'idle'),
      close('a', at(10, 30)),
      close('b', at(10, 30))
    ]
    const [day] = foldActivity(rows, DAY, DAY, NOW)
    // a works 10:00–10:10, b 10:05–10:20: coverage 20 min, peak 2, agent 25.
    expect(day.totals.coverageMin).toBe(20)
    expect(day.totals.peak).toBe(2)
    expect(day.totals.agentMin).toBe(25)
    expect(day.totals.openMin).toBe(30)
    expect(day.totals.peakOpen).toBe(2)
    expect(day.totals.sessionsOpened).toBe(2)
    expect(day.totals.bursts).toBe(2)
    expect(day.totals.leverage).toBeCloseTo(1.25)
    expect(day.working[10 * 60 + 7]).toBe(2)
    expect(day.working[10 * 60 + 15]).toBe(1)
    expect(day.working[10 * 60 + 20]).toBe(0)
    expect(day.sessions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(day.sessions[1].working).toEqual([[605, 620]])
    expect(day.hours.coverageMin[10]).toBe(20)
    expect(day.hours.agentMin[10]).toBe(25)
    expect(day.hours.coverageMin[11]).toBe(0)
    const [summary] = foldActivity(rows, DAY, DAY, NOW, false)
    expect(summary.working).toEqual([])
    expect(summary.totals).toEqual(day.totals)
    expect(summary.hours).toEqual(day.hours)
    expect(summary.sessions).toEqual(day.sessions)
  })

  it('a burst crossing midnight is split between the two days', () => {
    const rows = [
      open('a', at(23, 50, 0, 10)),
      state('a', at(23, 50, 0, 10), 'working'),
      state('a', at(0, 10, 0, 11), 'idle'),
      close('a', at(0, 20, 0, 11))
    ]
    const [d10, d11] = foldActivity(rows, '2026-10-10', DAY, NOW)
    expect(d10.totals.agentMin).toBe(10)
    expect(d10.totals.coverageMin).toBe(10)
    expect(d10.sessions[0].open).toEqual([1430, 1440])
    expect(d11.totals.agentMin).toBe(10)
    expect(d11.sessions[0].open).toEqual([0, 20])
    expect(d11.totals.sessionsOpened).toBe(0)
  })

  it('a crash gap: the synthetic quit written at the next boot ends the night', () => {
    const rows = [
      row({ kind: 'app', app: 'start', ts: at(20, 0, 0, 10) }),
      open('a', at(20, 1, 0, 10)),
      state('a', at(20, 2, 0, 10), 'working'),
      row({ kind: 'app', app: 'quit', ts: at(20, 32, 0, 10), synthetic: true }),
      row({ kind: 'app', app: 'start', ts: at(9, 0, 0, 11) })
    ]
    const [d10, d11] = foldActivity(rows, '2026-10-10', DAY, NOW)
    expect(d10.totals.agentMin).toBe(30)
    expect(d10.totals.appMin).toBe(32)
    expect(d11.totals.agentMin).toBe(0)
    expect(d11.totals.appMin).toBe(14 * 60)
    expect(d11.sessions).toEqual([])
  })

  it('minutes of the day read as the clock on the wall, and a range counts calendar days', () => {
    expect(minuteOfDay(new Date(2026, 9, 11, 9, 41, 30).getTime())).toBeCloseTo(581.5)
    // Seven days ending 30 March: the clocks changed on the 29th in Europe,
    // and the range is seven calendar days whatever the zone.
    const from = daysBack(new Date(2026, 2, 30, 0, 30).getTime(), 7)
    expect(from).toBe('2026-03-24')
    expect(dayRange(from, '2026-03-30')).toHaveLength(7)
  })

  it('a legacy span with no close is cut by the backfill, and an empty range is empty days', () => {
    const [day] = foldActivity([], DAY, DAY, NOW)
    expect(day.totals).toMatchObject({ coverageMin: 0, agentMin: 0, peak: 0, leverage: null })
    expect(day.sessions).toEqual([])
    expect(dayRange('2026-10-09', '2026-10-11')).toEqual(['2026-10-09', '2026-10-10', DAY])
    expect(localDayKey(new Date(2026, 0, 5, 1).getTime())).toBe('2026-01-05')
  })
})

describe('normalizeActivityRow', () => {
  it('accepts the four kinds and refuses the malformed', () => {
    expect(
      normalizeActivityRow({ kind: 'open', ts: at(1, 0), id: 'x', provider: 'claude' })
    ).toEqual({ v: 1, kind: 'open', ts: at(1, 0), id: 'x', provider: 'claude' })
    expect(
      normalizeActivityRow({ kind: 'state', ts: at(1, 0), id: 'x', state: 'working' })?.state
    ).toBe('working')
    expect(
      normalizeActivityRow({ kind: 'state', ts: at(1, 0), id: 'x', state: 'flying' })
    ).toBeNull()
    expect(
      normalizeActivityRow({ kind: 'app', ts: at(1, 0), app: 'quit', synthetic: true })
    ).toEqual({
      v: 1,
      kind: 'app',
      ts: at(1, 0),
      app: 'quit',
      synthetic: true
    })
    expect(normalizeActivityRow({ kind: 'app', ts: 'yesterday', app: 'quit' })).toBeNull()
    expect(normalizeActivityRow({ kind: 'close', ts: at(1, 0) })).toBeNull()
    expect(normalizeActivityRow('nope')).toBeNull()
  })
})
