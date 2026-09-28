import { useSessionStore, type Session } from '../store/session-store'
import {
  useClaudeProfileStore,
  getClaudeProfile,
  claudeProfileUsable,
  resolveClaudeProfile,
  type ClaudeProfile
} from '../store/claude-profile-store'
import {
  useCodexAccountStore,
  getCodexAccount,
  codexAccountUsable,
  resolveCodexAccount
} from '../store/codex-account-store'
import { accountsUsageFor, headroomLabel, type AccountUsageSummary } from '../store/usage-store'
import {
  explicitAccountId,
  isExhausted,
  pickAccount,
  switchTargets,
  type PoolAccount
} from './account-pool'
import type { CodexAccount } from '../../../preload/index.d'

/**
 * The pool at work (ADR 0002): which account a launch lands on, which one a
 * session moves to, and the move itself — the same tab restarted on the
 * other account with its conversation resumed.
 */
export type AccountProvider = 'claude' | 'codex'

/** The provider whose pool a session belongs to, or null (a terminal, Pi,
 *  Antigravity, a remote). */
export function accountProviderOf(session: Session): AccountProvider | null {
  if (session.sessionType !== 'local') return null
  if (session.claudeMode || session.claudeAgentsMode) return 'claude'
  if (session.codexMode) return 'codex'
  return null
}

/** The account a session is on, by provider. */
export function sessionAccountId(session: Session, provider: AccountProvider): string {
  return provider === 'codex'
    ? (session.codexAccountId ?? 'default')
    : (session.claudeProfileId ?? 'default')
}

function poolAccounts(provider: AccountProvider): PoolAccount[] {
  if (provider === 'codex') {
    return useCodexAccountStore.getState().accounts.map((a) => ({
      id: a.id,
      usable: codexAccountUsable(a),
      fallback: a.kind === 'apiKey'
    }))
  }
  return useClaudeProfileStore.getState().profiles.map((p) => ({
    id: p.id,
    usable: claudeProfileUsable(p)
  }))
}

/** The pool's pick for a new session. A named account is honored; when no
 *  account is named, the selected account is used while it has headroom, else
 *  the next one along. */
export function accountForLaunch(provider: 'claude', preferredId?: string): ClaudeProfile
export function accountForLaunch(provider: 'codex', preferredId?: string): CodexAccount
export function accountForLaunch(
  provider: AccountProvider,
  preferredId?: string
): ClaudeProfile | CodexAccount {
  const selected =
    provider === 'codex'
      ? useCodexAccountStore.getState().selectedAccountId
      : useClaudeProfileStore.getState().selectedProfileId
  // A named account is an instruction, not a preference. The launcher menu
  // passes the account the user clicked, so usage from another account must not
  // silently replace it. The automatic policy uses `nextAccountFor` below and
  // still rotates when the CLI reports a limit.
  if (preferredId !== undefined) {
    if (explicitAccountId(poolAccounts(provider), preferredId)) {
      return provider === 'codex' ? getCodexAccount(preferredId) : getClaudeProfile(preferredId)
    }
  }
  const id = pickAccount({
    accounts: poolAccounts(provider),
    usage: accountsUsageFor(provider),
    preferredId: preferredId ?? selected
  })
  return provider === 'codex' ? getCodexAccount(id) : getClaudeProfile(id)
}

/** An account named by an agent or a `.clave` file: an id, a label, or
 *  "any" for the pool's pick. Throws with the names that exist. */
export function resolveAccountRef(
  provider: AccountProvider,
  ref: string | undefined
): ClaudeProfile | CodexAccount {
  if (!ref || ref === 'any') {
    return provider === 'codex' ? accountForLaunch('codex') : accountForLaunch('claude')
  }
  if (provider === 'codex') {
    const { accounts } = useCodexAccountStore.getState()
    const account = resolveCodexAccount(accounts, ref)
    if (account) return account
    const names = accounts.map((a) => `"${a.label}" (${a.id})`).join(', ')
    throw new Error(`Unknown Codex account "${ref}". Available: ${names}`)
  }
  const { profiles } = useClaudeProfileStore.getState()
  const account = resolveClaudeProfile(profiles, ref)
  if (account) return account
  const names = profiles.map((p) => `"${p.label}" (${p.id})`).join(', ')
  throw new Error(`Unknown Claude account "${ref}". Available: ${names}`)
}

/** Whether the account a session runs on is about to stop it. */
export function sessionAccountExhausted(session: Session): boolean {
  const provider = accountProviderOf(session)
  if (!provider) return false
  return isExhausted(accountsUsageFor(provider)[sessionAccountId(session, provider)])
}

/** The summary of the account a session runs on, for a badge. */
export function sessionAccountUsage(session: Session): AccountUsageSummary | undefined {
  const provider = accountProviderOf(session)
  if (!provider) return undefined
  return accountsUsageFor(provider)[sessionAccountId(session, provider)]
}

/** The accounts a session could move to, with a label and headroom each. */
export function sessionSwitchTargets(
  session: Session
): { id: string; label: string; exhausted: boolean; headroom: string | null }[] {
  const provider = accountProviderOf(session)
  if (!provider) return []
  const current = sessionAccountId(session, provider)
  const labelOf = (id: string): string =>
    provider === 'codex' ? getCodexAccount(id).label : getClaudeProfile(id).label
  const usage = accountsUsageFor(provider)
  return switchTargets(poolAccounts(provider), usage, current).map((t) => ({
    ...t,
    label: labelOf(t.id),
    headroom: headroomLabel(usage[t.id])
  }))
}

/** The pool's next account for a session leaving the one it is on. Null
 *  when nowhere else has headroom. */
export function nextAccountFor(session: Session): string | null {
  const provider = accountProviderOf(session)
  if (!provider) return null
  const current = sessionAccountId(session, provider)
  const next = pickAccount({
    accounts: poolAccounts(provider),
    usage: accountsUsageFor(provider),
    preferredId: current,
    leavingId: current,
    preferSessionHeadroom: true
  })
  return next === current ? null : next
}

export interface SwitchResult {
  ok: boolean
  /** The conversation came along; false means the tab started fresh. */
  resumed: boolean
  error?: string
}

/**
 * Move a session to another account: main stops its process, spawns the
 * same thing again under the same id on the new account with the
 * conversation resumed, and the store remounts the pane on the answer.
 * `resendRejected` sends the message the old account's limit rejected again
 * on the new one — the move the limit itself caused, never a move by hand.
 */
export async function switchSessionAccount(
  sessionId: string,
  accountId: string,
  options: { resendRejected?: boolean } = {}
): Promise<SwitchResult> {
  const store = useSessionStore.getState()
  const session = store.sessions.find((s) => s.id === sessionId)
  if (!session) return { ok: false, resumed: false, error: 'No such session' }
  const provider = accountProviderOf(session)
  if (!provider) return { ok: false, resumed: false, error: 'This tab has no account to switch' }
  if (sessionAccountId(session, provider) === accountId) return { ok: true, resumed: true }
  const overrides =
    provider === 'codex'
      ? (() => {
          const account = getCodexAccount(accountId)
          return { codexAccountId: account.id, codexAccountLabel: account.label }
        })()
      : (() => {
          const profile = getClaudeProfile(accountId)
          return { claudeProfileId: profile.id, claudeProfileLabel: profile.label }
        })()
  store.setSessionRestarting(sessionId, true)
  const result = await window.electronAPI
    .restartSession(sessionId, { ...overrides, resendRejected: options.resendRejected === true })
    .catch((err) => ({
      error: err instanceof Error ? err.message : String(err)
    }))
  if ('error' in result) {
    useSessionStore.getState().setSessionRestarting(sessionId, false)
    return { ok: false, resumed: false, error: result.error }
  }
  const current = useSessionStore.getState()
  current.applySessionRestart(sessionId, {
    claudeSessionId: result.claudeSessionId,
    launchProfileId: result.launchProfileId,
    model: result.model,
    ...(provider === 'codex' ? overrides : { ...overrides, claudeConfigDir: undefined })
  })
  // The new process starts when its pane measures itself, which a pane that
  // is not on screen never does (a background tab moved by the policy would
  // sit pending until viewed). Kick it at a plain size, the way a restored
  // hidden session is kicked; a pane on screen refits it at once.
  const onScreen =
    current.activeView === 'terminals' && current.selectedSessionIds.includes(sessionId)
  if (!onScreen && session.sessionType === 'local') {
    window.electronAPI.startSession(sessionId, 120, 30)
  }
  return { ok: true, resumed: result.resumed }
}
