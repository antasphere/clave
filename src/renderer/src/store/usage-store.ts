import { create } from 'zustand'
import type { PiUsageTotals, UsageError, UsageLimits, UsageWindow } from '../../../preload/index.d'
import type { Session } from './session-types'
import {
  isSharedWindow,
  splitWindows,
  tightestOf,
  usageWindowsForModel
} from '../../../shared/usage-summary'
import { isExhausted, windowExhausted, type ScopedCap } from '../../../shared/account-pool'
import { createUsageResource, type UsageResource } from './usage-resource'
import { DEFAULT_CLAUDE_PROFILE_ID } from './claude-profile-store'
import { DEFAULT_CODEX_ACCOUNT_ID } from './codex-account-store'

export type UsageProvider = 'claude' | 'codex' | 'pi' | 'antigravity'
export const USAGE_PROVIDER_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  antigravity: 'Antigravity'
}

/** Local account data cannot describe a remote terminal's account. With no
 * selected tab we retain the default Claude overview; plain terminals have no quota. */
export function usageProviderForSession(
  session:
    | Pick<
        Session,
        | 'sessionType'
        | 'claudeMode'
        | 'claudeAgentsMode'
        | 'codexMode'
        | 'piMode'
        | 'antigravityMode'
      >
    | undefined
): UsageProvider | null {
  if (!session) return null
  if (session.sessionType !== 'local') return null
  if (session.piMode) return 'pi'
  if (session.codexMode) return 'codex'
  if (session.antigravityMode) return 'antigravity'
  return session.claudeMode || session.claudeAgentsMode ? 'claude' : null
}

async function limits(result: Promise<UsageLimits | UsageError>): Promise<UsageLimits> {
  const value = await result
  if ('error' in value) throw new Error(value.error)
  return value
}

// One cache per provider and Pi range, shared by the pane and sidebar. Switching
// tabs cannot let an outstanding request overwrite another provider's data.
//
// Claude is one cache PER ACCOUNT: the foot follows the focused tab's account,
// the settings page shows every account, the launcher's rows show each
// account's headroom. Main polls every account on its own clock and pushes
// each read (`usage:claude-account`); a resource created here for an account
// main has already read takes that read from the snapshot.
type ClaudeUsageResource = ReturnType<typeof createUsageResource<UsageLimits>>
const claudeStores = new Map<string, ClaudeUsageResource>()

export function claudeUsageStore(
  accountId: string = DEFAULT_CLAUDE_PROFILE_ID
): ClaudeUsageResource {
  let store = claudeStores.get(accountId)
  if (!store) {
    store = createUsageResource(({ force }) =>
      limits(window.electronAPI.getUsageLimits(accountId, { force }))
    )
    claudeStores.set(accountId, store)
    store.subscribe((state) => mirrorAccount(accountId, state))
  }
  return store
}

/** The machine login's cache, the one every pre-account caller reads. */
export const useUsageStore = claudeUsageStore(DEFAULT_CLAUDE_PROFILE_ID)

// Codex is one cache per account too (ADR 0002): each account is a home of
// its own, read on its own clock by main and pushed (`usage:codex-account`).
const codexStores = new Map<string, ClaudeUsageResource>()

export function codexUsageStore(accountId: string = DEFAULT_CODEX_ACCOUNT_ID): ClaudeUsageResource {
  let store = codexStores.get(accountId)
  if (!store) {
    store = createUsageResource(({ force }) =>
      limits(window.electronAPI.getCodexUsageLimits(accountId, { force }))
    )
    codexStores.set(accountId, store)
    store.subscribe((state) => mirrorCodexAccount(accountId, state))
  }
  return store
}

/** The machine's own Codex home, the one every pre-account caller reads. */
export const useCodexUsageStore = codexUsageStore(DEFAULT_CODEX_ACCOUNT_ID)
export const piUsageStores = {
  today: createUsageResource(() => window.electronAPI.getPiUsage('today')),
  '7d': createUsageResource(() => window.electronAPI.getPiUsage('7d')),
  '30d': createUsageResource(() => window.electronAPI.getPiUsage('30d')),
  all: createUsageResource(() => window.electronAPI.getPiUsage('all'))
}
export const quotaUsageStores = { claude: useUsageStore, codex: useCodexUsageStore }

/** What one account's read says, for a row that cannot subscribe to each
 *  account's resource (the launcher's menu rows, the session's context menu). */
export interface AccountUsageSummary {
  status: UsageResource<UsageLimits>['status']
  /** The window about to stop the view this summary describes, or null when
   *  none is known: an account's tightest SHARED cap (the 5-hour block, the
   *  weekly all-models cap), a session's tightest among the shared caps and
   *  its own family's (`claudeUsageForModel`). A family cap out is never an
   *  account's exhaustion: it is under `scopedOut`. */
  tightest: UsageWindow | null
  /** All returned windows, including the 5-hour session window used for balancing. */
  windows?: UsageWindow[]
  /** The tightest shared cap. */
  shared?: UsageWindow | null
  /** One entry per family cap in the view, each with its own exhaustion. */
  scoped?: (ScopedCap & { window: UsageWindow })[]
  /** The families whose cap is out (`['Fable']`). */
  scopedOut?: string[]
  error: string | null
  /** When main actually read these numbers (not when this window received
   *  them), or null before the first read. */
  fetchedAt?: number | null
  /** A read is under way. */
  refreshing?: boolean
  /** The service's own word when a read came back with no windows. */
  message?: string
}

/** One subscription for every account's read, mirrored from the resources. */
export const useClaudeAccountsUsage = create<{ byAccount: Record<string, AccountUsageSummary> }>(
  () => ({ byAccount: {} })
)
export const useCodexAccountsUsage = create<{ byAccount: Record<string, AccountUsageSummary> }>(
  () => ({ byAccount: {} })
)

/** The account view's fields over a read's windows: `tightest` over the
 *  shared caps alone, every family cap under `scoped` (the split of
 *  `shared/usage-summary.ts`). What `summarize` and the server settings'
 *  `summarizeUsageRead` both build from. */
export function accountUsageFieldsOf(
  windows: UsageWindow[]
): Pick<AccountUsageSummary, 'tightest' | 'windows' | 'shared' | 'scoped' | 'scopedOut'> {
  const split = splitWindows(windows)
  return { ...split, tightest: tightestOf(windows.filter(isSharedWindow)), windows }
}

function summarize(state: UsageResource<UsageLimits>): AccountUsageSummary {
  return {
    status: state.status,
    ...(state.status === 'error'
      ? { tightest: null, windows: undefined }
      : accountUsageFieldsOf(state.data?.windows ?? [])),
    error: state.error,
    fetchedAt: state.data?.fetchedAt ?? (state.status === 'error' ? state.fetchedAt : null),
    refreshing: state.refreshing,
    message: state.data?.message
  }
}

function mirrorAccount(accountId: string, state: UsageResource<UsageLimits>): void {
  useClaudeAccountsUsage.setState((current) => ({
    byAccount: { ...current.byAccount, [accountId]: summarize(state) }
  }))
}

function mirrorCodexAccount(accountId: string, state: UsageResource<UsageLimits>): void {
  useCodexAccountsUsage.setState((current) => ({
    byAccount: { ...current.byAccount, [accountId]: summarize(state) }
  }))
}

/** The per-account summaries of a provider, for the pool and the menus. */
export function accountsUsageFor(
  provider: 'claude' | 'codex'
): Record<string, AccountUsageSummary> {
  return provider === 'codex'
    ? useCodexAccountsUsage.getState().byAccount
    : useClaudeAccountsUsage.getState().byAccount
}

/** Take main's read for an account, creating the resource when the account is
 *  new to this window. */
export function publishClaudeAccountUsage(
  accountId: string,
  result: UsageLimits | UsageError
): void {
  const store = claudeUsageStore(accountId)
  if ('error' in result) store.getState().publishError(result.error)
  else store.getState().publish(result)
}

/** Every account's read, once the account list is known: what main already
 *  holds lands at once from its snapshot (a second window opens with the
 *  numbers the first one has), and the rest is read live. */
export async function primeClaudeAccountsUsage(accountIds: string[]): Promise<void> {
  const snapshot = await window.electronAPI.getClaudeUsageSnapshot().catch(() => ({}))
  // A read that succeeded is worth taking as it is; a failed one is not: a
  // window taking main's error would sit on it for the freshness window
  // instead of asking again, so a failed or missing read is read live.
  for (const id of accountIds) {
    const known = snapshot[id]
    if (known && !('error' in known)) publishClaudeAccountUsage(id, known)
    // Forced, or main would answer with the very error it cached.
    else void claudeUsageStore(id).getState().load({ force: true })
  }
}

export function publishCodexAccountUsage(
  accountId: string,
  result: UsageLimits | UsageError
): void {
  const store = codexUsageStore(accountId)
  if ('error' in result) store.getState().publishError(result.error)
  else store.getState().publish(result)
}

/** The Codex accounts' reads at boot: what main already holds, from its
 *  snapshot. Nothing is read live here — a Codex read is a `codex
 *  app-server` process, and main's five-minute clock starts one per account
 *  seconds after boot anyway; a window that needs a number sooner (the foot
 *  on a Codex tab, the Usage page) loads its store on demand. */
export async function primeCodexAccountsUsage(
  accounts: { id: string; hasCredential: boolean }[]
): Promise<void> {
  const snapshot = await window.electronAPI.getCodexUsageSnapshot?.().catch(() => ({}))
  for (const { id } of accounts) {
    const known = snapshot?.[id]
    if (known && !('error' in known)) publishCodexAccountUsage(id, known)
  }
}

// The footer and pane share the selected provider, including when settings is open.
export const useUsageNavigation = create<{
  provider: UsageProvider | null
  select: (provider: UsageProvider) => void
}>((set) => ({
  provider: null,
  select: (provider) => set({ provider })
}))

export function formatPiTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value
  )
}
export function piTodaySummary(totals: PiUsageTotals): string {
  return `${formatPiTokens(totals.totalTokens)} tokens · $${totals.cost.toFixed(2)} today`
}

/** Session views use shared caps plus caps for the explicitly known model.
 * Account-wide views omit the context to keep every reported cap. */
export function claudeModelWindows(windows: UsageWindow[], model?: string): UsageWindow[] {
  return usageWindowsForModel(windows, model)
}

/** The SESSION view of an account's summary: the shared caps plus the cap of
 *  the session's own model family, `tightest` over those; with no model,
 *  the shared caps alone. Claude's families (Fable, Opus) and Codex's model
 *  buckets (Spark) alike: a family is any window with a scope. */
export function usageForModel(
  summary: AccountUsageSummary | undefined,
  model?: string
): AccountUsageSummary | undefined {
  if (!summary || summary.status === 'error') return summary
  const windows = claudeModelWindows(
    summary.windows ?? (summary.tightest ? [summary.tightest] : []),
    model
  )
  return { ...summary, ...splitWindows(windows), windows }
}

/** The name the session view had when only Claude had families. */
export const claudeUsageForModel = usageForModel

/** The window about to stop a view, the shared rule (`tightestOf`): a cap
 * that is out first, the one back last among those, then the service's
 * severity, then utilization. With a model, over that model's caps. */
export function tightestWindow(
  windows: UsageWindow[],
  context?: { model?: string }
): UsageWindow | null {
  return tightestOf(context ? claudeModelWindows(windows, context.model) : windows)
}

/** The short name for a cap — what a one-line readout has room for. The
 *  same words everywhere a cap is named: `capName`. */
export function shortLabel(w: UsageWindow): string {
  return capName(w)
}

/** Whether a window is a weekly cap — the one that decides the week, which
 *  the Usage page puts first. By the service's own kind, never by a name. */
export function isWeeklyWindow(w: UsageWindow): boolean {
  return w.kind.startsWith('weekly')
}

/** "Thu 2 Oct, 14:00" — the moment a window resets, as a date a person can
 *  plan around. Null when the service did not say. */
export function formatResetAt(resetsAt: number | null): string | null {
  if (resetsAt == null) return null
  const at = new Date(resetsAt)
  const day = at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${day}, ${time}`
}

/** "in 2d 5h" / "in 3h 12m" / "in 4m": the distance to a reset, one unit
 *  finer than `formatReset`, which rounds a week down to its days. */
export function formatResetIn(resetsAt: number | null, now: number = Date.now()): string | null {
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

/** Read every account of both quota providers again, live, and the Pi
 *  ranges already on screen: the Usage page's one Refresh. Resolves when
 *  every read has landed, failed ones included. */
export async function refreshAllUsage(
  claudeAccountIds: string[],
  codexAccountIds: string[]
): Promise<void> {
  await Promise.all([
    ...claudeAccountIds.map((id) => claudeUsageStore(id).getState().load({ force: true })),
    ...codexAccountIds.map((id) => codexUsageStore(id).getState().load({ force: true })),
    ...Object.values(piUsageStores)
      .filter((store) => store.getState().status !== 'idle')
      .map((store) => store.getState().load({ force: true }))
  ])
}

/** "resets in 3h12m" / "resets in 2d". Null when the service did not say. */
export function formatReset(resetsAt: number | null): string | null {
  if (resetsAt == null) return null
  const secs = Math.max(0, Math.round((resetsAt - Date.now()) / 1000))
  const d = Math.floor(secs / 86400)
  if (d >= 1) return `resets in ${d}d`
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (h > 0) return `resets in ${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `resets in ${m}m`
  return 'resets shortly'
}

/** How urgent a cap reads, which picks its color. The service sends its own
 *  plan-aware severity; the more urgent of that and the percentage wins, so a
 *  scoped cap the percentage alone would understate still shows red. */
export function capLevel(w: UsageWindow): 'normal' | 'warning' | 'critical' {
  const fromPct =
    w.usedPercentage >= 90 ? 'critical' : w.usedPercentage >= 70 ? 'warning' : 'normal'
  const rank = { normal: 0, warning: 1, critical: 2 }
  const own = w.severity ?? 'normal'
  return rank[own] >= rank[fromPct] ? own : fromPct
}

/** The name a chart column has room for under its bar: the same words as a
 *  headroom line. */
export function columnLabel(w: UsageWindow): string {
  return capName(w)
}

/** A cap's name beside a headroom, capitalised like the model caps it sits
 *  among: "5h" for the session block, "Overall" for the all-models weekly
 *  cap, the model for a scoped one ("Fable"). */
export function capName(w: UsageWindow): string {
  if (w.scope) return w.scope
  if (w.kind === 'session') return '5h'
  if (w.kind === 'weekly_all') return 'Overall'
  return w.label
}

/** The cap a headroom line names: the tightest, except that an OPEN cap
 *  tied with it at the same whole percent gives way to the all-models
 *  weekly one, so an untouched account reads "100% left · Overall" rather
 *  than naming whichever window the service happened to list first. */
export function headroomWindow(summary: AccountUsageSummary | undefined): UsageWindow | null {
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
export function headroomLabel(summary: AccountUsageSummary | undefined): string | null {
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
export function capOutLabel(w: UsageWindow, words: CapWords = {}): string {
  const back =
    words.reset === 'at' ? formatResetAt(w.resetsAt) : formatResetIn(w.resetsAt, words.now)
  return back ? `${capName(w)} out · back ${back}` : `${capName(w)} out`
}

/** The parts every readout composes its words from. */
export interface CapStatus {
  /** "72% left · Overall": the headroom of the view's shared caps, or null
   *  when the shared cap is out. */
  headroom: string | null
  /** Every cap of the view that is out, named with its return, the shared
   *  cap first ("Overall out · back in 2d 5h", "Fable out · back Thu 2 Oct, 14:00"). */
  out: string[]
  /** The cap that stops the view: its tightest window when that is out. For
   *  a session view, the cap that stops THIS session; for an account view,
   *  the shared cap that stops every session on it. */
  stopping: UsageWindow | null
  /** Whether the view is out (`isExhausted`). */
  exhausted: boolean
}

/** The status of a view (an account's summary, or a session's through
 *  `claudeUsageForModel`), or null before a read and after a failed one.
 *  An account with 72% of its week left and its Fable cap spent reads
 *  `72% left · Overall` then `Fable out · back Thu 2 Oct, 14:00`; one whose
 *  week is spent reads `Overall out · back in 2d 5h`. */
export function capStatus(
  summary: AccountUsageSummary | undefined,
  words: CapWords = {}
): CapStatus | null {
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
  const byName = new Map<string, UsageWindow>()
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
  summary: AccountUsageSummary | undefined,
  words: CapWords = {}
): string | null {
  const status = capStatus(summary, words)
  if (!status) return null
  const parts = [status.headroom, ...status.out].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}

// Poll only providers/ranges that have been viewed. Codex is never started just
// because a Claude-only user opened Clave. Focus/wake refreshes stale data too.
// The Claude accounts are on main's clock: every push lands in its account's
// resource here, whichever window it reaches.
if (typeof window !== 'undefined') {
  const refresh = (): void => {
    for (const store of [
      ...claudeStores.values(),
      ...codexStores.values(),
      ...Object.values(piUsageStores)
    ]) {
      if (store.getState().status !== 'idle') void store.getState().load()
    }
  }
  setInterval(refresh, 5 * 60_000)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh()
  })
  window.electronAPI?.onClaudeAccountUsage?.(({ accountId, result }) =>
    publishClaudeAccountUsage(accountId, result)
  )
  window.electronAPI?.onCodexAccountUsage?.(({ accountId, result }) =>
    publishCodexAccountUsage(accountId, result)
  )
}
