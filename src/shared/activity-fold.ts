/**
 * The fold (PRDCT-3385): activity rows → what the Activity page draws. Pure,
 * no Electron, no clock of its own: `foldActivity` takes the rows, the range
 * of local days wanted and `now`, and answers one `DayActivity` per day.
 *
 * A session is a span from its `open` row to its `close` row (or `now` while
 * it is still open); inside it, the working bursts (a `working` state until
 * the next other state) and the blocked waits (a `blocked` state until the
 * next other state). An `ended` state or an `app quit` row closes every burst
 * and every span at that moment: nothing outlives the app.
 *
 * Every day carries three per-minute arrays over the local day (1440 cells):
 * how many sessions were working, how many were open, how many were blocked;
 * a minute counts a session when any part of the session's burst touches it.
 * The spans clipped to the day are kept beside them for the lanes, with
 * minute-of-day floats so the page can draw at second precision.
 */
import { isTrackedProvider, type ActivityRow } from './activity-model'

export const MINUTES_PER_DAY = 1440

/** `[start, end]` in milliseconds since the epoch; `end` is `now` while open. */
export type Interval = [number, number]

export interface SessionSpan {
  id: string
  provider: string
  name: string
  cwd: string
  model: string | null
  /** The provider's run state is known (Claude, Codex); false for Pi and terminals. */
  tracked: boolean
  /** The first open. */
  open: number
  /** null while the session is still open at `now`. */
  close: number | null
  /** Every stretch the session was open: a tab restored at boot or respawned
   *  on another account opens the same id again, and it stays one session. */
  opens: Interval[]
  working: Interval[]
  blocked: Interval[]
}

/** A span clipped to one local day, in minutes of that day (floats). */
export interface DaySession {
  id: string
  provider: string
  name: string
  cwd: string
  model: string | null
  tracked: boolean
  /** Still open at `now`. */
  live: boolean
  /** The envelope of the day's open stretches, in minutes of the day. */
  open: [number, number]
  /** The open stretches themselves, for the lane's faint bar. */
  opens: [number, number][]
  working: [number, number][]
  blocked: [number, number][]
  workingMin: number
  blockedMin: number
}

export interface DayTotals {
  /** Minutes of the day with at least one session working. */
  coverageMin: number
  /** Minutes of the day with at least one session open. */
  openMin: number
  /** Minutes of the day with the app running (0 when the record has no app rows for it). */
  appMin: number
  /** Sum over sessions of their working minutes. */
  agentMin: number
  /** Sum over sessions of their blocked minutes. */
  blockedMin: number
  /** Most sessions working in one minute. */
  peak: number
  /** Most sessions open in one minute. */
  peakOpen: number
  /** Sessions whose open moment falls in the day. */
  sessionsOpened: number
  /** Working bursts starting in the day. */
  bursts: number
  /** Median working burst, in seconds, of the bursts starting in the day; null without any. */
  medianBurstS: number | null
  /** Median blocked wait, in seconds; null without any. */
  medianBlockedS: number | null
  /** agentMin ÷ coverageMin; null when nothing worked. */
  leverage: number | null
}

export interface DayHours {
  /** Minutes of each hour (24 cells) with at least one session working. */
  coverageMin: number[]
  /** Session-minutes of each hour: the sum over sessions of their working minutes in it. */
  agentMin: number[]
}

export interface DayActivity {
  /** `YYYY-MM-DD` in local time. */
  day: string
  /** The per-minute arrays (1440 cells); empty when the day was folded as a summary. */
  working: number[]
  open: number[]
  blocked: number[]
  /** 1 where the app was running in the minute, 0 elsewhere. */
  app: number[]
  hours: DayHours
  sessions: DaySession[]
  totals: DayTotals
}

/** The longest a working burst is believed: a turn that never got its idle
 *  word (a dropped hook, a tab closed days later) would otherwise read as
 *  days of work. Six hours is past any turn seen; a longer one is cut there. */
export const MAX_BURST_MS = 6 * 3_600_000

/** The local `YYYY-MM-DD` of a timestamp. */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Midnight, local time, of a `YYYY-MM-DD`. */
export function localDayStart(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** A real local day key: the shape, and a round trip through the calendar
 *  (a 13th month or a 45th day would otherwise be read as some later day). */
export function isDayKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(key) &&
    localDayKey(localDayStart(key)) === key
  )
}

/** Every local day key from `from` to `to`, inclusive, in order. */
export function dayRange(from: string, to: string): string[] {
  const keys: string[] = []
  let cursor = localDayStart(from)
  const end = localDayStart(to)
  // Walk by local calendar day, not by 24 h, so a DST change does not skip or
  // repeat a day.
  while (cursor <= end && keys.length <= 400) {
    keys.push(localDayKey(cursor))
    const d = new Date(cursor)
    cursor = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  }
  return keys
}

interface OpenSession {
  span: SessionSpan
  openSince: number
  workingSince: number | null
  blockedSince: number | null
}

function endWorking(s: OpenSession, at: number): void {
  if (s.workingSince === null) return
  const end = Math.min(at, s.workingSince + MAX_BURST_MS)
  if (end > s.workingSince) s.span.working.push([s.workingSince, end])
  s.workingSince = null
}

function closeBursts(s: OpenSession, at: number): void {
  endWorking(s, at)
  if (s.blockedSince !== null) {
    if (at > s.blockedSince) s.span.blocked.push([s.blockedSince, at])
    s.blockedSince = null
  }
}

/** Rows → spans and the app's own intervals, in time order. */
export function spansFromRows(
  rows: ActivityRow[],
  now: number
): { spans: SessionSpan[]; app: Interval[] } {
  const sorted = rows
    .map((r) => ({ r, t: Date.parse(r.ts) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t)
  const open = new Map<string, OpenSession>()
  const byId = new Map<string, SessionSpan>()
  const spans: SessionSpan[] = []
  const app: Interval[] = []
  let appSince: number | null = null
  const closeSession = (s: OpenSession, at: number): void => {
    closeBursts(s, at)
    const end = Math.max(at, s.openSince)
    s.span.close = end
    if (end > s.openSince) s.span.opens.push([s.openSince, end])
    open.delete(s.span.id)
  }
  for (const { r, t } of sorted) {
    if (t > now) break
    if (r.kind === 'app') {
      if (r.app === 'start') {
        if (appSince === null) appSince = t
      } else {
        for (const s of [...open.values()]) closeSession(s, t)
        if (appSince !== null) {
          if (t > appSince) app.push([appSince, t])
          appSince = null
        }
      }
      continue
    }
    const id = r.id!
    if (r.kind === 'open') {
      if (open.has(id)) continue
      const known = byId.get(id)
      if (known) {
        // The same tab again (restored at boot, respawned on another
        // account): the one session opens a new stretch.
        known.close = null
        if (r.name) known.name = r.name
        if (r.cwd && !known.cwd) known.cwd = r.cwd
        if (r.model && !known.model) known.model = r.model
        open.set(id, { span: known, openSince: t, workingSince: null, blockedSince: null })
        continue
      }
      const span: SessionSpan = {
        id,
        provider: r.provider ?? 'terminal',
        name: r.name ?? '',
        cwd: r.cwd ?? '',
        model: r.model ?? null,
        tracked: isTrackedProvider(r.provider),
        open: t,
        close: null,
        opens: [],
        working: [],
        blocked: []
      }
      spans.push(span)
      byId.set(id, span)
      open.set(id, { span, openSince: t, workingSince: null, blockedSince: null })
      continue
    }
    const s = open.get(id)
    if (!s) continue
    if (r.kind === 'close') {
      if (r.name) s.span.name = r.name
      closeSession(s, t)
      continue
    }
    // state
    if (!s.span.tracked) continue
    const state = r.state
    if (state === 'ended') {
      closeBursts(s, t)
      continue
    }
    if (state === 'working') {
      if (s.blockedSince !== null) {
        if (t > s.blockedSince) s.span.blocked.push([s.blockedSince, t])
        s.blockedSince = null
      }
      if (s.workingSince === null) s.workingSince = t
      continue
    }
    if (state === 'blocked') {
      endWorking(s, t)
      if (s.blockedSince === null) s.blockedSince = t
      continue
    }
    // idle, done
    closeBursts(s, t)
  }
  for (const s of open.values()) {
    closeBursts(s, now)
    // still open: close stays null, the page reads it as live
    if (now > s.openSince) s.span.opens.push([s.openSince, now])
  }
  if (appSince !== null && now > appSince) app.push([appSince, now])
  return { spans, app }
}

function clip(iv: Interval, start: number, end: number): Interval | null {
  const a = Math.max(iv[0], start)
  const b = Math.min(iv[1], end)
  return b > a ? [a, b] : null
}

/** The minute of the local day a moment falls in, as the clock on the wall
 *  reads it (a float, seconds included). On the day the clocks go back the
 *  repeated hour lands on the same cells twice; on the day they go forward
 *  the missing hour leaves its cells empty. The page draws clock time. */
export function minuteOfDay(ms: number): number {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + (ms % 1000) / 60_000
}

/** An interval of a day in minutes of that day; an end on the day's last
 *  moment is 1440, never the next day's 0. */
function toMinutes(iv: Interval, dayEnd: number): [number, number] {
  const a = minuteOfDay(iv[0])
  const b = iv[1] >= dayEnd ? MINUTES_PER_DAY : minuteOfDay(iv[1])
  return [a, Math.max(a, b)]
}

/** The next whole-minute boundary after `t` (they align with the wall clock:
 *  every zone offset is a whole number of minutes). */
function nextMinute(t: number): number {
  return Math.floor(t / 60_000) * 60_000 + 60_000
}

/** The dedupe scratch of `paint`: one call is one session (or the app), and
 *  a cell counts once per call however many of the call's intervals touch it
 *  (two bursts inside one minute, the clock's repeated hour). */
const paintStamp = new Int32Array(MINUTES_PER_DAY)
let paintSeq = 0
const PAINT_SEQ_MAX = 0x7fffffff

/** Test hook: start the sequence near its limit, to prove the wrap. */
export function primePaintSeqForTests(seq: number): void {
  paintSeq = seq
}

/** Count each wall-clock minute touched by the intervals into `cells`, once
 *  per call: the intervals of one session count that session once a minute.
 *  The sequence is a 32-bit stamp: at its limit (about a day of the page
 *  open under continuous activity) the scratch is cleared and it starts
 *  over, so the dedupe never stops silently. */
function paint(cells: number[], intervals: Interval[], dayStart: number, dayEnd: number): void {
  if (paintSeq >= PAINT_SEQ_MAX) {
    paintStamp.fill(0)
    paintSeq = 0
  }
  const seq = ++paintSeq
  for (const iv of intervals) {
    const c = clip(iv, dayStart, dayEnd)
    if (!c) continue
    for (let t = c[0]; t < c[1]; t = nextMinute(t)) {
      const m = Math.min(MINUTES_PER_DAY - 1, Math.floor(minuteOfDay(t)))
      if (paintStamp[m] === seq) continue
      paintStamp[m] = seq
      cells[m]++
    }
  }
}

/** Real minutes of a set of intervals, in milliseconds on the clock of the
 *  epoch: a burst across a clock change is as long as it really was. */
function realMinutes(intervals: Interval[]): number {
  let total = 0
  for (const [a, b] of intervals) total += (b - a) / 60_000
  return total
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** One day's picture from the spans. */
export function foldDay(day: string, spans: SessionSpan[], app: Interval[]): DayActivity {
  const dayStart = localDayStart(day)
  const next = new Date(dayStart)
  const dayEnd = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1).getTime()
  const working = new Array<number>(MINUTES_PER_DAY).fill(0)
  const open = new Array<number>(MINUTES_PER_DAY).fill(0)
  const blocked = new Array<number>(MINUTES_PER_DAY).fill(0)
  const appCells = new Array<number>(MINUTES_PER_DAY).fill(0)
  const sessions: DaySession[] = []
  const burstSeconds: number[] = []
  const blockedSeconds: number[] = []
  let sessionsOpened = 0
  const inDay = (iv: Interval): Interval | null => clip(iv, dayStart, dayEnd)
  for (const span of spans) {
    const o = span.opens.map(inDay).filter((x): x is Interval => !!x)
    if (o.length === 0) continue
    if (span.open >= dayStart && span.open < dayEnd) sessionsOpened++
    const w = span.working.map(inDay).filter((x): x is Interval => !!x)
    const b = span.blocked.map(inDay).filter((x): x is Interval => !!x)
    paint(open, o, dayStart, dayEnd)
    paint(working, w, dayStart, dayEnd)
    paint(blocked, b, dayStart, dayEnd)
    for (const iv of span.working)
      if (iv[0] >= dayStart && iv[0] < dayEnd) burstSeconds.push((iv[1] - iv[0]) / 1000)
    for (const iv of span.blocked)
      if (iv[0] >= dayStart && iv[0] < dayEnd) blockedSeconds.push((iv[1] - iv[0]) / 1000)
    const om = o.map((iv) => toMinutes(iv, dayEnd))
    const wm = w.map((iv) => toMinutes(iv, dayEnd))
    const bm = b.map((iv) => toMinutes(iv, dayEnd))
    sessions.push({
      id: span.id,
      provider: span.provider,
      name: span.name,
      cwd: span.cwd,
      model: span.model,
      tracked: span.tracked,
      // Live on the day the open stretch reaches, not on an earlier day of
      // a tab reopened since.
      live: span.close === null && span.opens[span.opens.length - 1][0] < dayEnd,
      open: [om[0][0], om[om.length - 1][1]],
      opens: om,
      working: wm,
      blocked: bm,
      workingMin: realMinutes(w),
      blockedMin: realMinutes(b)
    })
  }
  paint(appCells, app, dayStart, dayEnd)
  for (let m = 0; m < MINUTES_PER_DAY; m++) if (appCells[m] > 1) appCells[m] = 1
  sessions.sort((a, b) => a.open[0] - b.open[0])
  let coverageMin = 0
  let openMin = 0
  let appMin = 0
  let peak = 0
  let peakOpen = 0
  for (let m = 0; m < MINUTES_PER_DAY; m++) {
    if (working[m] > 0) coverageMin++
    if (open[m] > 0) openMin++
    if (appCells[m] > 0) appMin++
    if (working[m] > peak) peak = working[m]
    if (open[m] > peakOpen) peakOpen = open[m]
  }
  const agentMin = sessions.reduce((t, s) => t + s.workingMin, 0)
  const blockedMin = sessions.reduce((t, s) => t + s.blockedMin, 0)
  const hours: DayHours = { coverageMin: new Array(24).fill(0), agentMin: new Array(24).fill(0) }
  for (let m = 0; m < MINUTES_PER_DAY; m++) {
    const h = Math.floor(m / 60)
    if (working[m] > 0) hours.coverageMin[h]++
    hours.agentMin[h] += working[m]
  }
  return {
    day,
    working,
    open,
    blocked,
    app: appCells,
    hours,
    sessions,
    totals: {
      coverageMin,
      openMin,
      appMin,
      agentMin,
      blockedMin,
      peak,
      peakOpen,
      sessionsOpened,
      bursts: burstSeconds.length,
      medianBurstS: median(burstSeconds),
      medianBlockedS: median(blockedSeconds),
      leverage: coverageMin > 0 ? agentMin / coverageMin : null
    }
  }
}

/** The whole fold: rows → one `DayActivity` per local day of the range. With
 *  `detail` false the per-minute arrays are left empty (a year of days is
 *  then a few hundred small objects); the hours, the sessions and the totals
 *  are computed either way. */
export function foldActivity(
  rows: ActivityRow[],
  from: string,
  to: string,
  now: number,
  detail = true
): DayActivity[] {
  const { spans, app } = spansFromRows(rows, now)
  return dayRange(from, to).map((day) => {
    const folded = foldDay(day, spans, app)
    if (detail) return folded
    return { ...folded, working: [], open: [], blocked: [], app: [] }
  })
}

/** The first local day key of a range `days` long ending today, by calendar
 *  day: a clock change inside the range neither adds nor drops a day. */
export function daysBack(now: number, days: number): string {
  const d = new Date(now)
  return localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime())
}
