/** One window of an account's usage read, as the pool reads it: the
 *  renderer's `UsageWindow` and main's own both fit it. */
export interface PoolUsageWindow {
  kind: string
  scope?: string | null
  usedPercentage: number
  severity?: string | null
  resetsAt?: number | null
}
/** One model family's weekly cap on an account (`usage-summary.ts`). */
export interface ScopedCap {
  /** The family as the service names it: `Fable`, `Opus`, `Sonnet`. */
  family: string
  window: PoolUsageWindow
  /** Out for the sessions on that family, and for them alone. */
  exhausted: boolean
}
/** What the pool needs of an account's usage summary. `tightest` is the
 *  window about to stop THE VIEW THE SUMMARY DESCRIBES (`usage-summary.ts`):
 *  an account's shared caps alone, or a session's shared caps plus its own
 *  family cap. The renderer's `AccountUsageSummary` fits it as it is; main
 *  builds one from the usage manager's read. */
export interface AccountUsageSummary {
  tightest: PoolUsageWindow | null
  windows?: PoolUsageWindow[]
  /** The tightest of the shared caps (the 5-hour block, the weekly all-models cap). */
  shared?: PoolUsageWindow | null
  /** One entry per family cap in the view. */
  scoped?: ScopedCap[]
  /** The families whose cap is out: a fact of its own, never the account's exhaustion. */
  scopedOut?: string[]
}

/**
 * The pool (ADR 0002): which account a new session starts on, and which one
 * a session about to hit its limit moves to. Pure over the ordered account
 * list and each account's usage summary, so the rule has a test of its own
 * and the two providers share it.
 *
 * A quota is per account AND model family. An account is EXHAUSTED when a
 * SHARED cap is about to stop it (about five percent or less left, or the
 * service already calls it critical); a session is exhausted when a shared
 * cap or ITS OWN FAMILY's cap is. The summary's `tightest` carries that
 * distinction (the caller filters a session's usage with its model first,
 * `usageSummaryForModel`), so a Fable week spent never puts the account out
 * for a launch on Opus. It is USABLE when it can be started on at all (a
 * token that works, a home with a credential). A FALLBACK account (a Codex
 * API key) has no quota to read: it is never exhausted and never chosen
 * while a subscription account has headroom.
 *
 * The order is the list's order, round robin: from the account just left,
 * the next usable one with headroom, wrapping. Automatic switches rank
 * those targets by their WEEKLY headroom, the 5-hour block only as a
 * tiebreak when every target has one (a verified Ultra account has none
 * since 30 October 2026). When every account is exhausted the one that
 * resets soonest is taken (the ADR's assumption, noted there), else the
 * preferred one stays.
 */
export const EXHAUSTED_LEFT_PERCENT = 5

/** Resolve a launcher's named account without consulting usage. */
export function explicitAccountId(
  accounts: PoolAccount[],
  preferredId: string | undefined
): string | null {
  if (preferredId === undefined) return null
  const account = accounts.find((candidate) => candidate.id === preferredId)
  return account?.usable ? account.id : null
}

export interface PoolAccount {
  id: string
  usable: boolean
  fallback?: boolean
}

/** Whether one cap is about to stop what draws on it: the service calls it
 *  critical, or about five percent is left. */
export function windowExhausted(w: PoolUsageWindow): boolean {
  if (w.severity === 'critical') return true
  return 100 - w.usedPercentage <= EXHAUSTED_LEFT_PERCENT
}

/** Whether a read says the view is about to stop: its tightest window is
 *  out. For an account that is a shared cap; a family cap out is `scopedOut`
 *  on the summary and never the account's exhaustion. Unknown usage (no read
 *  yet, a read that failed) is not exhaustion: the pool does not move a
 *  session on a guess. */
export function isExhausted(summary: AccountUsageSummary | undefined): boolean {
  const tightest = summary?.tightest
  if (!tightest) return false
  return windowExhausted(tightest)
}

/** The percent left of the tightest window, or null without a reading. */
export function headroomOf(summary: AccountUsageSummary | undefined): number | null {
  const tightest = summary?.tightest
  return tightest ? Math.max(0, Math.round(100 - tightest.usedPercentage)) : null
}

/** The weekly headroom of a view: the LEAST left among its weekly caps (the
 *  all-models cap and, in a session view, the session's family), the cap
 *  that binds the week. Null when the read names no weekly cap. */
export function weeklyHeadroomOf(summary: AccountUsageSummary | undefined): number | null {
  const weekly = (summary?.windows ?? []).filter((w) => w.kind.startsWith('weekly'))
  if (weekly.length === 0) return null
  return Math.min(...weekly.map((w) => 100 - w.usedPercentage))
}

/** The 5-hour block's headroom, or null when the plan has none. */
export function sessionHeadroomOf(summary: AccountUsageSummary | undefined): number | null {
  const window = summary?.windows?.find((candidate) => candidate.kind === 'session')
  return window ? 100 - window.usedPercentage : null
}

export interface PickInput {
  accounts: PoolAccount[]
  usage: Record<string, AccountUsageSummary | undefined>
  /** The account asked for: the one selected in settings, or the one a
   *  session runs on. Kept when it has headroom. */
  preferredId: string
  /** The account being left, when the pick is a move: the search starts
   *  after it. Absent, it starts after the preferred one. */
  leavingId?: string
  /** Accounts a pinned session may never land on (none today). */
  excludeIds?: string[]
  /** Prefer the open target with the most weekly headroom; the 5-hour
   *  block breaks a tie only when every open target has one. */
  preferWeeklyHeadroom?: boolean
  /** Use the menu recommendation for a new session, including the selected account. */
  preferRecommended?: boolean
}

/**
 * The account to start on. An opted-in launch uses the menu recommendation.
 * Otherwise keeps the preferred id while usable with headroom, then walks the ring.
 */
export function pickAccount(input: PickInput): string {
  const { accounts, usage, preferredId } = input
  const excluded = new Set(input.excludeIds ?? [])
  if (input.preferRecommended && input.leavingId === undefined) {
    const recommended = switchTargets(
      accounts.filter((a) => !excluded.has(a.id)),
      usage
    ).find((a) => a.suggested)
    if (recommended) return recommended.id
  }
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const preferred = byId.get(preferredId)
  const ok = (a: PoolAccount): boolean => a.usable && !excluded.has(a.id)
  const open = (a: PoolAccount): boolean => ok(a) && !a.fallback && !isExhausted(usage[a.id])
  if (preferred && open(preferred) && input.leavingId !== preferredId) return preferredId
  const from = input.leavingId ?? preferredId
  const start = Math.max(
    0,
    accounts.findIndex((a) => a.id === from)
  )
  const ring = [...accounts.slice(start + 1), ...accounts.slice(0, start + 1)]
  const openTargets = ring.filter((a) => a.id !== from && open(a))
  if (openTargets.length > 0) {
    if (input.preferWeeklyHeadroom) return rankByHeadroom(openTargets, usage)[0].id
    return openTargets[0].id
  }
  // Nothing with headroom: a fallback that can run, else whichever
  // subscription account comes back first, else stay where we are. A launch
  // (no account being left) keeps a SELECTED usable fallback before any other
  // key: the person chose that key (verifier, round 2: the ring search ends
  // on the selected one, so another key was found first). A switch searches
  // the ring after the account it leaves, never landing back on it.
  if (input.leavingId === undefined && preferred && ok(preferred) && preferred.fallback)
    return preferredId
  const fallback = ring.find((a) => a.id !== from && ok(a) && a.fallback)
  if (fallback) return fallback.id
  let soonest: { id: string; at: number } | null = null
  for (const a of accounts) {
    if (!ok(a) || a.fallback) continue
    const at = usage[a.id]?.tightest?.resetsAt ?? Number.MAX_SAFE_INTEGER
    if (!soonest || at < soonest.at) soonest = { id: a.id, at }
  }
  return soonest?.id ?? preferredId
}

/** Open targets by the most weekly headroom first (a target with no weekly
 *  read last), the 5-hour block breaking ties only when every target has
 *  one, the ring's order otherwise. Stable: a tie that nothing breaks keeps
 *  the ring's order. */
function rankByHeadroom(
  targets: PoolAccount[],
  usage: Record<string, AccountUsageSummary | undefined>
): PoolAccount[] {
  const everyHasSession = targets.every((a) => sessionHeadroomOf(usage[a.id]) !== null)
  return [...targets].sort((a, b) => {
    const aWeekly = weeklyHeadroomOf(usage[a.id])
    const bWeekly = weeklyHeadroomOf(usage[b.id])
    if (aWeekly !== bWeekly) {
      if (aWeekly === null) return 1
      if (bWeekly === null) return -1
      return bWeekly - aWeekly
    }
    if (everyHasSession) {
      const aSession = sessionHeadroomOf(usage[a.id]) as number
      const bSession = sessionHeadroomOf(usage[b.id]) as number
      if (aSession !== bSession) return bSession - aSession
    }
    return 0
  })
}

/** The soonest reset among a read's weekly caps, or null when none says.
 *  Weekly headroom is use-it-or-lose-it: the cap that renews first is the
 *  one to spend first. */
export function soonestWeeklyReset(summary: AccountUsageSummary | undefined): number | null {
  const resets = (summary?.windows ?? [])
    .filter((w) => w.kind.startsWith('weekly') && w.resetsAt != null)
    .map((w) => w.resetsAt as number)
  return resets.length > 0 ? Math.min(...resets) : null
}

/** The accounts a session could move to from the one it is on: every other
 *  usable one, those with headroom first, each side by its soonest weekly
 *  reset (an account that renews first is spent first; an exhausted one
 *  that renews first comes back first), the list's order breaking ties.
 *  The first one with headroom is SUGGESTED. For the menu. */
export function switchTargets(
  accounts: PoolAccount[],
  usage: Record<string, AccountUsageSummary | undefined>,
  currentId?: string
): { id: string; exhausted: boolean; suggested: boolean; weeklyResetAt: number | null }[] {
  const ranked = accounts
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => a.id !== currentId && a.usable)
    .map(({ a, index }) => ({
      id: a.id,
      index,
      fallback: a.fallback === true,
      exhausted: !a.fallback && isExhausted(usage[a.id]),
      weeklyResetAt: soonestWeeklyReset(usage[a.id])
    }))
    .sort((x, y) => {
      if (x.exhausted !== y.exhausted) return Number(x.exhausted) - Number(y.exhausted)
      // A fallback (an API key) is the last resort among the open ones.
      if (x.fallback !== y.fallback) return Number(x.fallback) - Number(y.fallback)
      const rx = x.weeklyResetAt ?? Number.POSITIVE_INFINITY
      const ry = y.weeklyResetAt ?? Number.POSITIVE_INFINITY
      if (rx !== ry) return rx < ry ? -1 : 1
      return x.index - y.index
    })
  const suggested = ranked.find((t) => !t.exhausted && !t.fallback)?.id
  return ranked.map(({ id, exhausted, weeklyResetAt }) => ({
    id,
    exhausted,
    suggested: id === suggested,
    weeklyResetAt
  }))
}
