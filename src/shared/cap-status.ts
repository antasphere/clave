/**
 * A connection's usage put into words: the headroom line, the cap that is
 * out and when it comes back. ONE vocabulary for every readout, the
 * launcher's rows in the window and the agent tools served by main or the
 * daemon alike ("72% left · Overall · Fable out · back in 2d 5h").
 *
 * Pure: no store, no window, no Electron. `Date.now()` appears only as the
 * default of a `now` parameter. The renderer's usage store re-exports every
 * name here, so its importers keep their words and their types.
 *
 * The types are structural so that both shapes of a read fit: the
 * renderer's `AccountUsageSummary` (with `status`, `error`, labelled
 * windows) and the shared one of `account-pool.ts` (neither). Functions
 * that hand a window back are generic over it, so a caller gets back the
 * window type it gave.
 */
import { isExhausted, windowExhausted, type PoolUsageWindow, type ScopedCap } from './account-pool'
import { tightestOf, usageWindowsForModel } from './usage-summary'

/** One cap of a read: the pool's window, plus the label and key the
 *  renderer's windows carry (the service's own name, `Weekly · Fable`). */
export interface CapWindow extends PoolUsageWindow {
  label?: string
  key?: string
}

/** What the words need of a view's summary: the split of
 *  `usage-summary.ts`, plus the read's own status where the caller has one
 *  (the renderer's resource: a failed read says nothing). */
export interface CapSummary<W extends CapWindow = CapWindow> {
  tightest: W | null
  windows?: W[]
  shared?: W | null
  scoped?: (ScopedCap & { window: W })[]
  scopedOut?: string[]
  status?: string
  error?: string | null
  message?: string
}

/** The window about to stop a view, the shared rule (`tightestOf`): a cap
 * that is out first, the one back last among those, then the service's
 * severity, then utilization. With a model, over that model's caps. */
export function tightestWindow<W extends PoolUsageWindow>(
  windows: W[],
  context?: { model?: string }
): W | null {
  return tightestOf(context ? usageWindowsForModel(windows, context.model) : windows)
}

/** The short name for a cap — what a one-line readout has room for. The
 *  same words everywhere a cap is named: `capName`. */
export function shortLabel(w: CapWindow): string {
  return capName(w)
}

/** Whether a window is a weekly cap — the one that decides the week, which
 *  the Usage page puts first. By the service's own kind, never by a name. */
export function isWeeklyWindow(w: PoolUsageWindow): boolean {
  return w.kind.startsWith('weekly')
}

/** "Thu 2 Oct, 14:00" — the moment a window resets, as a date a person can
 *  plan around. Null when the service did not say. */
export function formatResetAt(resetsAt: number | null | undefined): string | null {
  if (resetsAt == null) return null
  const at = new Date(resetsAt)
  const day = at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${day}, ${time}`
}

/** "in 2d 5h" / "in 3h 12m" / "in 4m": the distance to a reset, one unit
 *  finer than `formatReset`, which rounds a week down to its days. */
export function formatResetIn(
  resetsAt: number | null | undefined,
  now: number = Date.now()
): string | null {
  if (resetsAt == null) return null
  const secs = Math.max(0, Math.round((resetsAt - now) / 1000))
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d >= 1) return h > 0 ? `in ${d}d ${h}h` : `in ${d}d`
  if (h >= 1) return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`
  if (m >= 1) return `in ${m}m`
  return 'shortly'
}

/** "just now" / "4 min ago" / "2 h ago": how old a read is. */
export function formatAge(at: number | null | undefined, now: number = Date.now()): string | null {
  if (at == null) return null
  const secs = Math.max(0, Math.round((now - at) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min ago`
  return `${Math.round(mins / 60)} h ago`
}

type CapLevel = 'normal' | 'warning' | 'critical'
const LEVEL_RANK: Record<CapLevel, number> = { normal: 0, warning: 1, critical: 2 }

/** How urgent a cap reads, which picks its color. The service sends its own
 *  plan-aware severity; the more urgent of that and the percentage wins, so a
 *  scoped cap the percentage alone would understate still shows red. */
export function capLevel(w: PoolUsageWindow): CapLevel {
  const fromPct: CapLevel =
    w.usedPercentage >= 90 ? 'critical' : w.usedPercentage >= 70 ? 'warning' : 'normal'
  const own: CapLevel =
    w.severity === 'warning' || w.severity === 'critical' ? w.severity : 'normal'
  return LEVEL_RANK[own] >= LEVEL_RANK[fromPct] ? own : fromPct
}

/** The name a chart column has room for under its bar: the same words as a
 *  headroom line. */
export function columnLabel(w: CapWindow): string {
  return capName(w)
}

/** A cap's name beside a headroom, capitalised like the model caps it sits
 *  among: "5h" for the session block, "Overall" for the all-models weekly
 *  cap, the model for a scoped one ("Fable"), else the service's label
 *  (the kind when a window carries none). */
export function capName(w: CapWindow): string {
  if (w.scope) return w.scope
  if (w.kind === 'session') return '5h'
  if (w.kind === 'weekly_all') return 'Overall'
  return w.label ?? w.kind
}

/** The cap a headroom line names: the tightest, except that an OPEN cap
 *  tied with it at the same whole percent gives way to the all-models
 *  weekly one, so an untouched account reads "100% left · Overall" rather
 *  than naming whichever window the service happened to list first. */
export function headroomWindow<W extends CapWindow>(summary: CapSummary<W> | undefined): W | null {
  const tightest = summary?.tightest
  if (!tightest) return null
  // A cap that is out is the line, whatever ties with it: the one rule made
  // it the cap that binds, and the chip and the notice name it.
  if (windowExhausted(tightest)) return tightest
  const overall = summary.windows?.find((w) => w.kind === 'weekly_all')
  if (
    overall &&
    overall !== tightest &&
    (tightest.severity ?? 'normal') === (overall.severity ?? 'normal') &&
    Math.round(overall.usedPercentage) === Math.round(tightest.usedPercentage)
  ) {
    return overall
  }
  return tightest
}

/** "72% left · Overall", the one line a menu row has room for. */
export function headroomLabel(summary: CapSummary | undefined): string | null {
  const w = headroomWindow(summary)
  if (!w) return null
  const left = Math.max(0, Math.round(100 - w.usedPercentage))
  return `${left}% left · ${capName(w)}`
}

/** How a cap's return is written: `in` for a one-line readout ("back in 2d
 *  5h"), `at` where there is room for a date ("back Thu 2 Oct, 14:00"). */
export interface CapWords {
  now?: number
  reset?: 'in' | 'at'
}

/** "Fable out · back in 2d 5h": the ONE way a cap that is out is named,
 *  everywhere. The cap by `capName`, the return by `formatResetIn` or
 *  `formatResetAt`; no return when the service gave none. Never a bare
 *  "At limit" or "Limit reached": those said neither which cap nor when. */
export function capOutLabel(w: CapWindow, words: CapWords = {}): string {
  const back =
    words.reset === 'at' ? formatResetAt(w.resetsAt) : formatResetIn(w.resetsAt, words.now)
  return back ? `${capName(w)} out · back ${back}` : `${capName(w)} out`
}

/** The parts every readout composes its words from. */
export interface CapStatus<W extends CapWindow = CapWindow> {
  /** "72% left · Overall": the headroom of the view's shared caps, or null
   *  when the shared cap is out. */
  headroom: string | null
  /** Every cap of the view that is out, named with its return, the shared
   *  cap first ("Overall out · back in 2d 5h", "Fable out · back Thu 2 Oct, 14:00"). */
  out: string[]
  /** The cap that stops the view: its tightest window when that is out. For
   *  a session view, the cap that stops THIS session; for an account view,
   *  the shared cap that stops every session on it. */
  stopping: W | null
  /** Whether the view is out (`isExhausted`). */
  exhausted: boolean
}

/** The status of a view (an account's summary, or a session's through
 *  `usageSummaryForModel`), or null before a read and after a failed one.
 *  An account with 72% of its week left and its Fable cap spent reads
 *  `72% left · Overall` then `Fable out · back Thu 2 Oct, 14:00`; one whose
 *  week is spent reads `Overall out · back in 2d 5h`. */
export function capStatus<W extends CapWindow>(
  summary: CapSummary<W> | undefined,
  words: CapWords = {}
): CapStatus<W> | null {
  if (!summary || summary.status === 'error') return null
  // A read that names only family caps has no tightest for the account as a
  // whole, and still has families to name.
  if (!summary.tightest && !summary.scoped?.length) return null
  const exhausted = isExhausted(summary)
  // The stopping cap is the view's tightest, which the one rule makes the
  // cap out that comes back last; the others out follow in the read's
  // order, one entry per name with its latest return (Codex's Spark block
  // and Spark week both out read "Spark out" once, back when the week is).
  const stopping = exhausted ? summary.tightest : null
  const windows = summary.windows ?? (summary.tightest ? [summary.tightest] : [])
  const byName = new Map<string, W>()
  for (const w of [...(stopping ? [stopping] : []), ...windows]) {
    if (!windowExhausted(w)) continue
    const held = byName.get(capName(w))
    if (!held || (w.resetsAt ?? -1) > (held.resetsAt ?? -1)) byName.set(capName(w), w)
  }
  const out = [...byName.values()].map((w) => capOutLabel(w, words))
  // The shared headroom: the tightest shared cap while it is open. A session
  // view whose family cap is out still says what the account has left.
  const shared = summary.shared === undefined ? summary.tightest : summary.shared
  const headroom =
    shared && !isExhausted({ tightest: shared })
      ? headroomLabel({ ...summary, tightest: shared })
      : null
  return { headroom, out, stopping, exhausted }
}

/** The one line a row has room for: the headroom, then every cap that is
 *  out, ` · ` between ("72% left · Overall · Fable out · back in 2d 5h"). */
export function capStatusLine(
  summary: CapSummary | undefined,
  words: CapWords = {}
): string | null {
  const status = capStatus(summary, words)
  if (!status) return null
  const parts = [status.headroom, ...status.out].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}
