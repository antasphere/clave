import { create } from 'zustand'
import type { PiUsageTotals, UsageError, UsageLimits, UsageWindow } from '../../../preload/index.d'
import type { Session } from './session-types'
import { createUsageResource, type UsageResource } from './usage-resource'
import { DEFAULT_CLAUDE_PROFILE_ID } from './claude-profile-store'

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
export const useCodexUsageStore = createUsageResource(() =>
  limits(window.electronAPI.getCodexUsageLimits())
)
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
  /** The window about to stop this account, or null when none is known. */
  tightest: UsageWindow | null
  error: string | null
}

/** One subscription for every account's read, mirrored from the resources. */
export const useClaudeAccountsUsage = create<{ byAccount: Record<string, AccountUsageSummary> }>(
  () => ({ byAccount: {} })
)

function mirrorAccount(accountId: string, state: UsageResource<UsageLimits>): void {
  useClaudeAccountsUsage.setState((current) => ({
    byAccount: {
      ...current.byAccount,
      [accountId]: {
        status: state.status,
        tightest: state.status === 'error' ? null : tightestWindow(state.data?.windows ?? []),
        error: state.error
      }
    }
  }))
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

/**
 * The window that is actually going to stop you: the one with the least left,
 * the service's own severity taken first where it disagrees with the raw
 * percentage (it is plan-aware and we are not).
 *
 * This is the auto-detection. Which caps an account has is not ours to know —
 * a session block, a weekly all-models cap, one weekly cap per model, and
 * whatever the service adds next — so nothing here names a window. It reads
 * whatever came back and picks the tightest.
 */
export function tightestWindow(windows: UsageWindow[]): UsageWindow | null {
  const rank = { normal: 0, warning: 1, critical: 2 }
  let best: UsageWindow | null = null
  for (const w of windows) {
    if (!best) {
      best = w
      continue
    }
    const a = rank[w.severity ?? 'normal']
    const b = rank[best.severity ?? 'normal']
    if (a > b || (a === b && w.usedPercentage > best.usedPercentage)) best = w
  }
  return best
}

/** The short name for a cap — what a one-line readout has room for. */
export function shortLabel(w: UsageWindow): string {
  if (w.scope) return w.scope
  if (w.kind === 'session') return 'session'
  if (w.kind === 'weekly_all') return 'weekly'
  return w.label
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

/** "72% left · session", the one line a menu row has room for. */
export function headroomLabel(summary: AccountUsageSummary | undefined): string | null {
  if (!summary || !summary.tightest) return null
  const left = Math.max(0, Math.round(100 - summary.tightest.usedPercentage))
  return `${left}% left · ${shortLabel(summary.tightest)}`
}

// Poll only providers/ranges that have been viewed. Codex is never started just
// because a Claude-only user opened Clave. Focus/wake refreshes stale data too.
// The Claude accounts are on main's clock: every push lands in its account's
// resource here, whichever window it reaches.
if (typeof window !== 'undefined') {
  const refresh = (): void => {
    for (const store of [
      ...claudeStores.values(),
      useCodexUsageStore,
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
}
