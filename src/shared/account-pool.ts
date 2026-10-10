/** One window of an account's usage read, as the pool reads it: the
 *  renderer's `UsageWindow` and main's own both fit it. */
export interface PoolUsageWindow {
  kind: string
  usedPercentage: number
  severity?: string | null
  resetsAt?: number | null
}
/** What the pool needs of an account's usage summary: the tightest window
 *  and the windows themselves. The renderer's `AccountUsageSummary` fits it
 *  as it is; main builds one from the usage manager's read. */
export interface AccountUsageSummary {
  tightest: PoolUsageWindow | null
  windows?: PoolUsageWindow[]
}

/**
 * The pool (ADR 0002): which account a new session starts on, and which one
 * a session about to hit its limit moves to. Pure over the ordered account
 * list and each account's usage summary, so the rule has a test of its own
 * and the two providers share it.
 *
 * An account is EXHAUSTED when its tightest window has about five percent or
 * less left, or the service already calls it critical. It is USABLE when it
 * can be started on at all (a token that works, a home with a credential).
 * A FALLBACK account (a Codex API key) has no quota to read: it is never
 * exhausted and never chosen while a subscription account has headroom.
 *
 * The order is the list's order, round robin: from the account just left,
 * the next usable one with headroom, wrapping. Automatic switches can rank
 * those targets by their 5-hour session headroom. When every account is
 * exhausted the one that resets soonest is taken (the ADR's assumption,
 * noted there), else the preferred one stays.
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

/** Whether a read says the account is about to stop. Unknown usage (no read
 *  yet, a read that failed) is not exhaustion: the pool does not move a
 *  session on a guess. */
export function isExhausted(summary: AccountUsageSummary | undefined): boolean {
  const tightest = summary?.tightest
  if (!tightest) return false
  if (tightest.severity === 'critical') return true
  return 100 - tightest.usedPercentage <= EXHAUSTED_LEFT_PERCENT
}

/** The percent left of the tightest window, or null without a reading. */
export function headroomOf(summary: AccountUsageSummary | undefined): number | null {
  const tightest = summary?.tightest
  return tightest ? Math.max(0, Math.round(100 - tightest.usedPercentage)) : null
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
  /** Prefer the account with the most 5-hour headroom among open targets. */
  preferSessionHeadroom?: boolean
}

/**
 * The account to start on. Returns the preferred id when it is usable and
 * has headroom; otherwise walks the ring from the account being left.
 */
export function pickAccount(input: PickInput): string {
  const { accounts, usage, preferredId } = input
  const excluded = new Set(input.excludeIds ?? [])
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
    if (input.preferSessionHeadroom) {
      const sessionHeadroom = (id: string): number | null => {
        const window = usage[id]?.windows?.find((candidate) => candidate.kind === 'session')
        return window ? 100 - window.usedPercentage : null
      }
      const hasSessionRead = openTargets.some((a) => sessionHeadroom(a.id) !== null)
      if (hasSessionRead) {
        return [...openTargets].sort((a, b) => {
          const aHeadroom = sessionHeadroom(a.id)
          const bHeadroom = sessionHeadroom(b.id)
          if (aHeadroom === null) return 1
          if (bHeadroom === null) return -1
          return bHeadroom - aHeadroom
        })[0].id
      }
    }
    return openTargets[0].id
  }
  // Nothing with headroom: a fallback that can run, else whichever
  // subscription account comes back first, else stay where we are.
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
  currentId: string
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
