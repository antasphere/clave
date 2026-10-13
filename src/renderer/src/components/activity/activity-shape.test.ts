import { describe, expect, it } from 'vitest'
import type { DayActivity, DaySession } from '../../../../shared/activity-fold'
import {
  HEATMAP_WEEKS,
  OTHER_PROJECTS,
  busiestDay,
  byProject,
  byProvider,
  fmtLeverage,
  fmtMinutes,
  fmtPct,
  fmtSeconds,
  fmtDayLong,
  heatmapCells,
  hourProfile,
  localDayKey,
  nextDay,
  rangeBounds,
  rangeTotals,
  modelLabel,
  streak,
  activitySummary,
  fmtDayMonth,
  laneDetails,
  laneOrder,
  mondayOf,
  plural,
  weeklyTrend
} from './activity-shape'

// Sunday 11 October 2026, mid-afternoon, local time.
const NOW = new Date(2026, 9, 11, 15, 30).getTime()

function session(over: Partial<DaySession> = {}): DaySession {
  return {
    id: 's1',
    provider: 'claude',
    name: 'one',
    cwd: '/Users/x/projects/alpha',
    model: 'opus',
    tracked: true,
    live: false,
    open: [60, 180],
    opens: over.open ? [over.open] : [[60, 180]],
    working: [[60, 120]],
    blocked: [],
    workingMin: 60,
    blockedMin: 0,
    ...over
  }
}

function day(
  key: string,
  over: Partial<DayActivity['totals']> = {},
  sessions: DaySession[] = []
): DayActivity {
  return {
    day: key,
    working: [],
    open: [],
    blocked: [],
    app: [],
    hours: { coverageMin: new Array(24).fill(0), agentMin: new Array(24).fill(0) },
    sessions,
    totals: {
      coverageMin: 0,
      openMin: 0,
      appMin: 0,
      agentMin: 0,
      blockedMin: 0,
      peak: 0,
      peakOpen: 0,
      sessionsOpened: 0,
      bursts: 0,
      medianBurstS: null,
      medianBlockedS: null,
      leverage: null,
      ...over
    }
  }
}

describe('rangeBounds', () => {
  it('answers today, 7 and 30 days and the year, ending today', () => {
    expect(rangeBounds('today', NOW)).toEqual({ from: '2026-10-11', to: '2026-10-11' })
    expect(rangeBounds('7d', NOW)).toEqual({ from: '2026-10-05', to: '2026-10-11' })
    expect(rangeBounds('30d', NOW)).toEqual({ from: '2026-09-12', to: '2026-10-11' })
    expect(rangeBounds('year', NOW).to).toBe('2026-10-11')
    expect(rangeBounds('year', NOW).from).toBe('2025-10-12')
  })
  it('steps calendar days', () => {
    expect(nextDay('2026-10-11', 1)).toBe('2026-10-12')
    expect(nextDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(nextDay('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('rangeTotals', () => {
  it('sums, takes the max peak and the median of the medians', () => {
    const a = day(
      '2026-10-10',
      {
        coverageMin: 100,
        agentMin: 150,
        blockedMin: 10,
        peak: 2,
        sessionsOpened: 3,
        bursts: 4,
        medianBurstS: 30,
        medianBlockedS: 20
      },
      [session({ id: 'a' })]
    )
    const b = day(
      '2026-10-11',
      {
        coverageMin: 50,
        agentMin: 75,
        blockedMin: 5,
        peak: 3,
        sessionsOpened: 1,
        bursts: 2,
        medianBurstS: 90,
        medianBlockedS: null
      },
      [session({ id: 'a' }), session({ id: 'b', workingMin: 0 })]
    )
    const t = rangeTotals([a, b])
    expect(t.coverageMin).toBe(150)
    expect(t.agentMin).toBe(225)
    expect(t.blockedMin).toBe(15)
    expect(t.peak).toBe(3)
    expect(t.sessionsOpened).toBe(4)
    expect(t.sessionsWorked).toBe(1)
    expect(t.bursts).toBe(6)
    expect(t.medianBurstS).toBe(60)
    expect(t.medianBlockedS).toBe(20)
    expect(t.leverage).toBeCloseTo(1.5)
    expect(t.daysWithActivity).toBe(2)
    expect(t.avgCoveragePct).toBeCloseTo(150 / 2880)
  })
  it('has no leverage without coverage', () => {
    expect(rangeTotals([day('2026-10-11')]).leverage).toBeNull()
    expect(rangeTotals([]).avgCoveragePct).toBe(0)
  })
})

describe('hourProfile', () => {
  it('sums the hours over the days', () => {
    const a = day('2026-10-10')
    const b = day('2026-10-11')
    a.hours.coverageMin[9] = 30
    b.hours.coverageMin[9] = 15
    b.hours.agentMin[9] = 40
    const p = hourProfile([a, b])
    expect(p.coverageMin).toHaveLength(24)
    expect(p.coverageMin[9]).toBe(45)
    expect(p.agentMin[9]).toBe(40)
  })
})

describe('heatmapCells', () => {
  const year: DayActivity[] = []
  for (let i = 364; i >= 0; i--) year.push(day(localDayKey(NOW - i * 86_400_000)))

  it('is 53 weeks of 7 days, Monday first, today the last day in range', () => {
    const { weeks } = heatmapCells(year, NOW)
    expect(weeks).toHaveLength(HEATMAP_WEEKS)
    for (const w of weeks) expect(w).toHaveLength(7)
    for (const w of weeks) expect(new Date(`${w[0].day}T12:00:00`).getDay()).toBe(1)
    const cells = weeks.flat()
    // A Sunday: today closes the last column.
    expect(cells[cells.length - 1]).toMatchObject({ day: '2026-10-11', inRange: true })
    // Before the data: out of range.
    expect(cells[0].inRange).toBe(false)
  })

  it('leaves the days after today out of range on a weekday', () => {
    const wednesday = new Date(2026, 9, 7, 9, 0).getTime()
    const cells = heatmapCells(year, wednesday).weeks.flat()
    const inRange = cells.filter((c) => c.inRange)
    expect(inRange[inRange.length - 1].day).toBe('2026-10-07')
    expect(cells[cells.length - 1]).toMatchObject({ day: '2026-10-11', inRange: false })
    expect(new Date(`${cells[0].day}T12:00:00`).getDay()).toBe(1)
  })

  it('levels by quartile so one huge day does not flatten the rest', () => {
    const days = [
      day('2026-10-08', { agentMin: 10 }),
      day('2026-10-09', { agentMin: 20 }),
      day('2026-10-10', { agentMin: 30 }),
      day('2026-10-11', { agentMin: 6000 }),
      day('2026-10-07')
    ]
    const cells = heatmapCells(days, NOW).weeks.flat()
    const level = (k: string): number | undefined => cells.find((c) => c.day === k)?.level
    expect(level('2026-10-07')).toBe(0)
    expect(level('2026-10-08')).toBe(1)
    expect(level('2026-10-09')).toBe(2)
    expect(level('2026-10-10')).toBe(3)
    expect(level('2026-10-11')).toBe(4)
  })

  it('counts the streak and finds the busiest day', () => {
    const days = [
      day('2026-10-08', { agentMin: 10 }),
      day('2026-10-09'),
      day('2026-10-10', { agentMin: 30 }),
      day('2026-10-11', { agentMin: 5 })
    ]
    expect(streak(days, '2026-10-11')).toBe(2)
    expect(streak(days, '2026-10-09')).toBe(0)
    expect(busiestDay(days)).toEqual({ day: '2026-10-10', agentMin: 30 })
    expect(busiestDay([day('2026-10-11')])).toBeNull()
  })
})

describe('byProject and byProvider', () => {
  it('sorts by agent time and folds past the eighth into Other', () => {
    const sessions = Array.from({ length: 11 }, (_, i) =>
      session({ id: `s${i}`, cwd: `/work/p${i}`, workingMin: (i + 1) * 10 })
    )
    const rows = byProject([day('2026-10-11', {}, sessions)])
    expect(rows).toHaveLength(9)
    expect(rows[0]).toMatchObject({ label: 'p10', agentMin: 110, sessions: 1 })
    expect(rows.slice(0, 8).map((r) => r.agentMin)).toEqual([110, 100, 90, 80, 70, 60, 50, 40])
    expect(rows[8]).toMatchObject({
      cwd: OTHER_PROJECTS,
      label: 'Other',
      agentMin: 60,
      sessions: 3
    })
  })
  it('counts a session over several days once', () => {
    const rows = byProject([
      day('2026-10-10', {}, [session({ id: 'x', workingMin: 5 })]),
      day('2026-10-11', {}, [session({ id: 'x', workingMin: 7 })])
    ])
    expect(rows).toEqual([
      { cwd: '/Users/x/projects/alpha', label: 'alpha', agentMin: 12, sessions: 1 }
    ])
  })
  it('gives untracked agents their open time', () => {
    const rows = byProvider([
      day('2026-10-11', {}, [
        session({ id: 'a', workingMin: 30 }),
        session({
          id: 'b',
          provider: 'pi',
          model: null,
          tracked: false,
          open: [0, 90],
          workingMin: 0
        })
      ])
    ])
    expect(rows[0]).toMatchObject({ provider: 'claude', model: 'opus', agentMin: 30, sessions: 1 })
    expect(rows[1]).toMatchObject({ provider: 'pi', tracked: false, agentMin: 0, openMin: 90 })
  })
})

describe('the formatters', () => {
  it('write minutes, percents, seconds and leverage the house way', () => {
    expect(fmtMinutes(125)).toBe('2 h 05')
    expect(fmtMinutes(48)).toBe('48 min')
    expect(fmtMinutes(0)).toBe('0 min')
    expect(fmtMinutes(59.6)).toBe('1 h 00')
    expect(fmtPct(0.69)).toBe('69 %')
    expect(fmtPct(0)).toBe('0 %')
    expect(fmtPct(0.004)).toBe('0.4 %')
    expect(fmtPct(1 / 1440)).toBe('< 0.1 %')
    expect(fmtSeconds(48)).toBe('48 s')
    expect(fmtSeconds(660)).toBe('11 min')
    expect(fmtSeconds(null)).toBe('—')
    expect(fmtLeverage(2.345)).toBe('2.3×')
    expect(fmtLeverage(null)).toBe('—')
    expect(fmtDayLong('2026-10-10')).toBe('Saturday 10 October')
  })
})

describe('modelLabel', () => {
  it('names the Claude ids and leaves the rest as written', () => {
    expect(modelLabel('claude-fable-5-1', 'claude')).toBe('Fable 5.1')
    expect(modelLabel('claude-opus-5-5[1m]', 'claude')).toBe('Opus 5.5 · 1M')
    expect(modelLabel('opus', 'claude')).toBe('Opus')
    expect(modelLabel('gpt-5-codex', 'codex')).toBe('gpt-5-codex')
    expect(modelLabel(null, 'claude')).toBe('Claude Code')
  })
})

describe('laneOrder', () => {
  it('reads by first burst, then the tracked sessions that never worked, then the untracked', () => {
    const late = session({ id: 'late', open: [0, 600], working: [[500, 520]] })
    const early = session({
      id: 'early',
      open: [300, 900],
      working: [
        [700, 710],
        [310, 320]
      ]
    })
    const idle = session({ id: 'idle', open: [10, 50], working: [], workingMin: 0 })
    const pi = session({ id: 'pi', provider: 'pi', tracked: false, open: [5, 50], working: [] })
    const idleLater = session({ id: 'idle2', open: [20, 50], working: [], workingMin: 0 })
    expect(laneOrder([pi, idleLater, late, idle, early]).map((s) => s.id)).toEqual([
      'early',
      'late',
      'idle',
      'idle2',
      'pi'
    ])
  })
})

describe('laneDetails', () => {
  it('names the project, the model, the time and the bursts', () => {
    const s = session({
      name: 'build',
      model: 'claude-opus-5-5',
      working: [
        [603.4, 640],
        [800, 881.2]
      ],
      workingMin: 72,
      blockedMin: 6,
      live: true
    })
    expect(laneDetails(s)).toEqual([
      'build',
      'alpha',
      'Opus 5.5',
      'working 1 h 12 · waiting 6 min',
      'first burst 10:03 · last 14:41',
      'still open'
    ])
  })

  it('leaves the model out when none was asked for, and the bursts when none ran', () => {
    const s = session({ model: null, working: [], workingMin: 0 })
    expect(laneDetails(s)).toEqual(['one', 'alpha', 'working 0 min · waiting 0 min'])
  })

  it('gives an untracked agent its open time', () => {
    const s = session({ provider: 'pi', tracked: false, model: null, working: [], open: [60, 180] })
    expect(laneDetails(s)[2]).toBe('open 2 h 00, run state not known')
  })
})

describe('weeklyTrend', () => {
  it('folds the days into ISO weeks, Monday first', () => {
    expect(mondayOf('2026-10-11')).toBe('2026-10-05') // a Sunday
    expect(mondayOf('2026-10-05')).toBe('2026-10-05')
    expect(mondayOf('2026-10-01')).toBe('2026-09-28')
    const days = [
      day('2026-09-30', { coverageMin: 144, peak: 3, agentMin: 200 }),
      day('2026-10-01', { coverageMin: 432, peak: 9, agentMin: 500 }),
      day('2026-10-04', { coverageMin: 0, peak: 0, agentMin: 0 }),
      day('2026-10-05', { coverageMin: 0, peak: 0, agentMin: 0 }),
      day('2026-10-06', { coverageMin: 0, peak: 0, agentMin: 0 })
    ]
    const weeks = weeklyTrend(days)
    expect(weeks.map((w) => w.monday)).toEqual(['2026-09-28', '2026-10-05'])
    const [a, b] = weeks
    expect(a.days).toBe(3)
    expect(a.avgCoveragePct).toBeCloseTo((0.1 + 0.3 + 0) / 3)
    expect(a.peak).toBe(9)
    expect(a.agentMin).toBe(700)
    expect(a.target).toBe('2026-10-01')
    expect(a.monthLabel).toBe('Oct')
    // A week without any agent time opens on its Monday, and holds no first.
    expect(b.target).toBe('2026-10-05')
    expect(b.monthLabel).toBeNull()
    expect(b.avgCoveragePct).toBe(0)
  })

  it('crosses a year', () => {
    const weeks = weeklyTrend([day('2026-12-31'), day('2027-01-03'), day('2027-01-04')])
    expect(weeks.map((w) => [w.monday, w.days, w.monthLabel])).toEqual([
      ['2026-12-28', 2, 'Jan'],
      ['2027-01-04', 1, null]
    ])
  })
})

describe('activitySummary', () => {
  it('says what one day held', () => {
    const d = day('2026-10-11', { agentMin: 485, peak: 6 }, [
      session({ id: 'a', workingMin: 400 }),
      session({ id: 'b', workingMin: 85 })
    ])
    expect(activitySummary([d])).toBe('Sessions worked 8 h 05 across 2 sessions, up to 6 at once.')
    expect(activitySummary([day('2026-10-11', {}, [session({ workingMin: 0 })])])).toBe(
      'No session worked that day.'
    )
    expect(
      activitySummary([day('2026-10-11', { agentMin: 30, peak: 1 }, [session({ workingMin: 30 })])])
    ).toBe('Sessions worked 30 min across 1 session, up to 1 at once.')
  })

  it('averages a range over its days with activity', () => {
    const days = [
      day('2026-10-09', { agentMin: 600, peak: 15 }, [
        session({ id: 'a', workingMin: 300 }),
        session({ id: 'b', workingMin: 300 }),
        session({ id: 'c', workingMin: 0 })
      ]),
      day('2026-10-10', { agentMin: 0 }),
      day('2026-10-11', { agentMin: 370, peak: 4 }, [session({ id: 'a', workingMin: 370 })])
    ]
    expect(activitySummary(days)).toBe(
      'On an average active day, sessions worked 8 h 05 across 2 sessions, up to 15 at once; 2 of 3 days had activity.'
    )
    expect(activitySummary([day('2026-10-10'), day('2026-10-11')])).toBe(
      'No session worked in these 2 days.'
    )
  })
})

describe('the small words', () => {
  it('writes one and many, and a day with its month', () => {
    expect(plural(1, 'session')).toBe('1 session')
    expect(plural(0, 'day')).toBe('0 days')
    expect(fmtDayMonth('2026-04-06')).toBe('6 April')
  })
})
