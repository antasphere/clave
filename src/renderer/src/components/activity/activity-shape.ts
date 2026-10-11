/**
 * The Activity page's arithmetic (PRDCT-3385): the folded days the main
 * process answers (`shared/activity-fold.ts`) → what each section draws.
 * Pure: no React, no DOM, no clock of its own; every function that needs
 * "today" takes `now`.
 */
import {
  MINUTES_PER_DAY,
  daysBack,
  localDayKey,
  localDayStart,
  minuteOfDay,
  type DayActivity,
  type DaySession
} from '../../../../shared/activity-fold'

export { daysBack, localDayKey, localDayStart, minuteOfDay, MINUTES_PER_DAY }

export type ActivityRange = 'today' | '7d' | '30d' | 'year'

export const RANGE_DAYS: Record<ActivityRange, number> = {
  today: 1,
  '7d': 7,
  '30d': 30,
  year: 365
}

/** The inclusive local days a range covers, ending today. */
export function rangeBounds(range: ActivityRange, now: number): { from: string; to: string } {
  const to = localDayKey(now)
  return { from: range === 'today' ? to : daysBack(now, RANGE_DAYS[range]), to }
}

/** The local day `delta` calendar days from `key` (DST-safe). */
export function nextDay(key: string, delta: number): string {
  const d = new Date(localDayStart(key))
  return localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta).getTime())
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export interface RangeTotals {
  coverageMin: number
  agentMin: number
  blockedMin: number
  /** Most sessions working in one minute, over the whole range. */
  peak: number
  sessionsOpened: number
  /** Distinct sessions that worked at least once in the range. */
  sessionsWorked: number
  bursts: number
  /** The median of the days' own medians (null when no day has one). */
  medianBurstS: number | null
  medianBlockedS: number | null
  /** agentMin ÷ coverageMin; null when nothing worked. */
  leverage: number | null
  daysWithActivity: number
  /** coverageMin ÷ (days × 1440), 0..1. */
  avgCoveragePct: number
}

export function rangeTotals(days: DayActivity[]): RangeTotals {
  let coverageMin = 0
  let agentMin = 0
  let blockedMin = 0
  let peak = 0
  let sessionsOpened = 0
  let bursts = 0
  let daysWithActivity = 0
  const burstMedians: number[] = []
  const blockedMedians: number[] = []
  const worked = new Set<string>()
  for (const day of days) {
    const t = day.totals
    coverageMin += t.coverageMin
    agentMin += t.agentMin
    blockedMin += t.blockedMin
    peak = Math.max(peak, t.peak)
    sessionsOpened += t.sessionsOpened
    bursts += t.bursts
    if (t.agentMin > 0) daysWithActivity++
    if (t.medianBurstS !== null) burstMedians.push(t.medianBurstS)
    if (t.medianBlockedS !== null) blockedMedians.push(t.medianBlockedS)
    for (const s of day.sessions) if (s.workingMin > 0) worked.add(s.id)
  }
  return {
    coverageMin,
    agentMin,
    blockedMin,
    peak,
    sessionsOpened,
    sessionsWorked: worked.size,
    bursts,
    medianBurstS: median(burstMedians),
    medianBlockedS: median(blockedMedians),
    leverage: coverageMin > 0 ? agentMin / coverageMin : null,
    daysWithActivity,
    avgCoveragePct: days.length > 0 ? coverageMin / (days.length * MINUTES_PER_DAY) : 0
  }
}

/** The 24 hours of the day, summed over the days. */
export function hourProfile(days: DayActivity[]): { coverageMin: number[]; agentMin: number[] } {
  const coverageMin = new Array<number>(24).fill(0)
  const agentMin = new Array<number>(24).fill(0)
  for (const day of days) {
    for (let h = 0; h < 24; h++) {
      coverageMin[h] += day.hours.coverageMin[h] ?? 0
      agentMin[h] += day.hours.agentMin[h] ?? 0
    }
  }
  return { coverageMin, agentMin }
}

export type HeatLevel = 0 | 1 | 2 | 3 | 4

export interface HeatCell {
  day: string
  agentMin: number
  coverageMin: number
  level: HeatLevel
  /** A day the record answered and that is not in the future. */
  inRange: boolean
}

export const HEATMAP_WEEKS = 53

/** Monday = 0 … Sunday = 6. */
function weekdayIndex(key: string): number {
  return (new Date(localDayStart(key)).getDay() + 6) % 7
}

/**
 * The year as 53 columns of 7 days, Monday on the first row, the last column
 * the current week (its days after today out of range). The level is the
 * day's rank among the days that had any agent time, in quartiles, so one
 * very long day does not flatten every other one to the lightest step.
 */
export function heatmapCells(days: DayActivity[], now: number): { weeks: HeatCell[][] } {
  const today = localDayKey(now)
  const byDay = new Map(days.map((d) => [d.day, d]))
  const active = days
    .map((d) => d.totals.agentMin)
    .filter((v) => v > 0)
    .sort((a, b) => a - b)
  const levelOf = (value: number): HeatLevel => {
    if (value <= 0 || active.length === 0) return 0
    // How many active days are at or under this one: the day's quantile.
    let lo = 0
    let hi = active.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (active[mid] <= value) lo = mid + 1
      else hi = mid
    }
    return Math.max(1, Math.min(4, Math.ceil((4 * lo) / active.length))) as HeatLevel
  }
  const thisMonday = nextDay(today, -weekdayIndex(today))
  const first = nextDay(thisMonday, -7 * (HEATMAP_WEEKS - 1))
  const weeks: HeatCell[][] = []
  let cursor = first
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const week: HeatCell[] = []
    for (let d = 0; d < 7; d++) {
      const folded = byDay.get(cursor)
      const agentMin = folded?.totals.agentMin ?? 0
      week.push({
        day: cursor,
        agentMin,
        coverageMin: folded?.totals.coverageMin ?? 0,
        level: levelOf(agentMin),
        inRange: !!folded && cursor <= today
      })
      cursor = nextDay(cursor, 1)
    }
    weeks.push(week)
  }
  return { weeks }
}

/** Consecutive days ending today with any agent time. */
export function streak(days: DayActivity[], today: string): number {
  const byDay = new Map(days.map((d) => [d.day, d.totals.agentMin]))
  let n = 0
  let cursor = today
  while ((byDay.get(cursor) ?? 0) > 0) {
    n++
    cursor = nextDay(cursor, -1)
  }
  return n
}

/** The day with the most agent time, or null when none had any. */
export function busiestDay(days: DayActivity[]): { day: string; agentMin: number } | null {
  let best: { day: string; agentMin: number } | null = null
  for (const d of days)
    if (d.totals.agentMin > 0 && (!best || d.totals.agentMin > best.agentMin))
      best = { day: d.day, agentMin: d.totals.agentMin }
  return best
}

function basename(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** The order the lanes read in: the sessions that worked by their first
 *  burst, then the tracked ones that never worked, then the agents whose run
 *  state is not known (Pi, terminals), those two by the moment they opened. */
export function laneOrder<T extends Pick<DaySession, 'working' | 'open' | 'tracked'>>(
  sessions: T[]
): T[] {
  const group = (s: T): number => (s.working.length > 0 ? 0 : s.tracked ? 1 : 2)
  const start = (s: T): number =>
    s.working.length > 0 ? Math.min(...s.working.map(([a]) => a)) : s.open[0]
  return [...sessions].sort(
    (a, b) => group(a) - group(b) || start(a) - start(b) || a.open[0] - b.open[0]
  )
}

/** What a selected lane says under the lanes, part by part: the name, the
 *  project, the model when one was asked for, the time worked and waited,
 *  the first burst and the end of the last, and whether it is still open. */
export function laneDetails(s: DaySession): string[] {
  const parts = [s.name || providerLabel(s.provider), basename(s.cwd) || 'No folder']
  if (s.model) parts.push(modelLabel(s.model, s.provider))
  parts.push(
    s.tracked
      ? `working ${fmtMinutes(s.workingMin)} · waiting ${fmtMinutes(s.blockedMin)}`
      : `open ${fmtMinutes(s.opens.reduce((t, [a, b]) => t + (b - a), 0))}, run state not known`
  )
  if (s.working.length > 0) {
    const first = Math.min(...s.working.map(([a]) => a))
    const last = Math.max(...s.working.map(([, b]) => b))
    parts.push(`first burst ${fmtClock(first)} · last ${fmtClock(last)}`)
  }
  if (s.live) parts.push('still open')
  return parts
}

/** The Monday that opens a day's ISO week. */
export function mondayOf(key: string): string {
  return nextDay(key, -weekdayIndex(key))
}

export interface WeekBar {
  /** The Monday the week starts on. */
  monday: string
  /** How many of the week's days the range carries. */
  days: number
  /** The mean of those days' coverage, 0..1. */
  avgCoveragePct: number
  /** Most sessions working in one minute, over the week. */
  peak: number
  agentMin: number
  /** The day a click opens: the week's busiest, or its Monday when none worked. */
  target: string
  /** The short month when the week holds the first of a month, else null. */
  monthLabel: string | null
}

/** The range one bar per ISO week (Monday first), oldest first. */
export function weeklyTrend(days: DayActivity[]): WeekBar[] {
  const weeks = new Map<string, DayActivity[]>()
  for (const d of days) {
    const monday = mondayOf(d.day)
    const list = weeks.get(monday)
    if (list) list.push(d)
    else weeks.set(monday, [d])
  }
  return [...weeks.keys()].sort().map((monday) => {
    const list = weeks.get(monday) ?? []
    let first: string | null = null
    for (let i = 0; i < 7 && first === null; i++) {
      const key = nextDay(monday, i)
      if (key.endsWith('-01')) first = key
    }
    return {
      monday,
      days: list.length,
      avgCoveragePct:
        list.reduce((t, d) => t + d.totals.coverageMin / MINUTES_PER_DAY, 0) / list.length,
      peak: Math.max(0, ...list.map((d) => d.totals.peak)),
      agentMin: list.reduce((t, d) => t + d.totals.agentMin, 0),
      target: busiestDay(list)?.day ?? monday,
      monthLabel: first ? fmtMonthShort(first) : null
    }
  })
}

/** One sentence under the tiles. One day: what it held. A range: its average
 *  day with activity, the most at once, and how many days had any. */
export function activitySummary(days: DayActivity[]): string {
  const t = rangeTotals(days)
  if (days.length === 1) {
    if (t.agentMin <= 0) return 'No session worked that day.'
    return `Sessions worked ${fmtMinutes(t.agentMin)} across ${plural(t.sessionsWorked, 'session')}, up to ${t.peak} at once.`
  }
  const active = days.filter((d) => d.totals.agentMin > 0)
  if (active.length === 0) return `No session worked in these ${plural(days.length, 'day')}.`
  const avgAgent = t.agentMin / active.length
  const avgSessions = Math.max(
    1,
    Math.round(
      active.reduce((n, d) => n + d.sessions.filter((s) => s.workingMin > 0).length, 0) /
        active.length
    )
  )
  return `On an average active day, sessions worked ${fmtMinutes(avgAgent)} across ${plural(avgSessions, 'session')}, up to ${t.peak} at once; ${t.daysWithActivity} of ${plural(days.length, 'day')} had activity.`
}

export interface ProjectShare {
  cwd: string
  label: string
  agentMin: number
  sessions: number
}

export const OTHER_PROJECTS = '__other__'

/** Agent time per folder, the eight largest and the rest as Other. */
export function byProject(days: DayActivity[], top = 8): ProjectShare[] {
  const map = new Map<string, { agentMin: number; ids: Set<string> }>()
  for (const day of days)
    for (const s of day.sessions) {
      const entry = map.get(s.cwd) ?? { agentMin: 0, ids: new Set<string>() }
      entry.agentMin += s.workingMin
      entry.ids.add(s.id)
      map.set(s.cwd, entry)
    }
  const rows = [...map.entries()]
    .map(([cwd, e]) => ({
      cwd,
      label: basename(cwd) || 'No folder',
      agentMin: e.agentMin,
      sessions: e.ids.size
    }))
    .sort((a, b) => b.agentMin - a.agentMin || b.sessions - a.sessions)
  if (rows.length <= top + 1) return rows
  const rest = rows.slice(top)
  return [
    ...rows.slice(0, top),
    {
      cwd: OTHER_PROJECTS,
      label: 'Other',
      agentMin: rest.reduce((t, r) => t + r.agentMin, 0),
      sessions: rest.reduce((t, r) => t + r.sessions, 0)
    }
  ]
}

export interface ProviderShare {
  provider: string
  model: string | null
  /** The provider's run state is known; when not, only `openMin` means anything. */
  tracked: boolean
  agentMin: number
  /** Sum of the sessions' open spans, in minutes. */
  openMin: number
  sessions: number
}

/** Agent time per agent and model. Untracked agents (Pi, terminals) carry
 *  their open time instead, their agent time being unknown. */
export function byProvider(days: DayActivity[]): ProviderShare[] {
  const map = new Map<string, ProviderShare & { ids: Set<string> }>()
  for (const day of days)
    for (const s of day.sessions) {
      const key = `${s.provider}\u0000${s.model ?? ''}`
      const entry = map.get(key) ?? {
        provider: s.provider,
        model: s.model,
        tracked: s.tracked,
        agentMin: 0,
        openMin: 0,
        sessions: 0,
        ids: new Set<string>()
      }
      entry.agentMin += s.tracked ? s.workingMin : 0
      for (const [a, b] of s.opens) entry.openMin += b - a
      entry.ids.add(s.id)
      map.set(key, entry)
    }
  return [...map.values()]
    .map(({ ids, ...rest }) => ({ ...rest, sessions: ids.size }))
    .sort(
      (a, b) =>
        Number(b.tracked) - Number(a.tracked) || b.agentMin - a.agentMin || b.openMin - a.openMin
    )
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  pi: 'Pi',
  terminal: 'Terminal',
  echo: 'Echo'
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

const CLAUDE_MODEL = /^claude-(fable|opus|sonnet|haiku)-(\d+)-(\d+)(\[1m\])?$/
const CLAUDE_FAMILY = /^(fable|opus|sonnet|haiku)$/

/** A model id as a name: `claude-fable-5-1` is `Fable 5.1`, `claude-opus-5-5[1m]`
 *  is `Opus 5.5 · 1M`, a bare `opus` is `Opus`; anything else stays as the
 *  provider wrote it. Null is the provider's own default. */
export function modelLabel(model: string | null, provider: string): string {
  if (model === null || model === '') return providerLabel(provider)
  const claude = CLAUDE_MODEL.exec(model)
  if (claude) {
    const [, family, major, minor, long] = claude
    const name = `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`
    return long ? `${name} · 1M` : name
  }
  if (CLAUDE_FAMILY.test(model)) return model.charAt(0).toUpperCase() + model.slice(1)
  return model
}

// ── Words and numbers, as the house writes them ────────────────────────────

/** `1 session`, `3 sessions`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** `2 h 05`, `48 min`, `0 min`. */
export function fmtMinutes(min: number): string {
  const total = Math.max(0, Math.round(min))
  if (total < 60) return `${total} min`
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')}`
}

/** `69 %`; under one percent with a decimal so a little is not written 0. */
export function fmtPct(x: number): string {
  const pct = Math.max(0, x * 100)
  if (pct === 0) return '0 %'
  if (pct < 0.1) return '< 0.1 %'
  if (pct < 1) return `${pct.toFixed(1)} %`
  return `${Math.round(pct)} %`
}

/** `48 s`, `11 min`, `1 h 20`; a dash when there is nothing to measure. */
export function fmtSeconds(s: number | null): string {
  if (s === null) return '—'
  if (s < 59.5) return `${Math.round(s)} s`
  return fmtMinutes(s / 60)
}

/** `2.3×`. */
export function fmtLeverage(x: number | null): string {
  return x === null ? '—' : `${x.toFixed(1)}×`
}

/** `09:41` for a minute of the day. */
export function fmtClock(minute: number): string {
  const m = Math.max(0, Math.min(MINUTES_PER_DAY, Math.floor(minute)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

/** `Saturday 11 October`. */
export function fmtDayLong(key: string): string {
  const d = new Date(localDayStart(key))
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** `6 April`. */
export function fmtDayMonth(key: string): string {
  const d = new Date(localDayStart(key))
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** `11 Oct`. */
export function fmtDayShort(key: string): string {
  const d = new Date(localDayStart(key))
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`
}

/** `Oct`. */
export function fmtMonthShort(key: string): string {
  return MONTHS[new Date(localDayStart(key)).getMonth()].slice(0, 3)
}
