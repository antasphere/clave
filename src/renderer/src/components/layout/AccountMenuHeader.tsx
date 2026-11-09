import { ClaudeLogo, CodexLogo } from '../icons/cli-logos'
import {
  useClaudeProfileStore,
  getClaudeProfile,
  sessionAccount,
  describeClaudeProfileAuth
} from '../../store/claude-profile-store'
import {
  useCodexAccountStore,
  getCodexAccount,
  sessionCodexAccount,
  describeCodexAccountAuth
} from '../../store/codex-account-store'
import {
  useClaudeAccountsUsage,
  useCodexAccountsUsage,
  capStatus,
  formatReset,
  claudeUsageForModel
} from '../../store/usage-store'
import { soonestWeeklyReset } from '../../lib/account-pool'
import type { Session } from '../../store/session-types'
import { useNow } from '../../lib/use-now'
import { AccountUsageBars } from './AccountSwitchMenu'

/**
 * The header of a Claude or Codex session's context menu: which account the
 * session runs on and that account's headroom. Live while the menu is open:
 * a read that lands meanwhile updates the line. With `chart`, the account's
 * caps follow as one thin horizontal bar each (AccountUsageBars), compact so
 * the header never outweighs the menu under it.
 */
export function AccountMenuHeader({
  session,
  chart = false
}: {
  session: Session
  chart?: boolean
}): React.JSX.Element {
  const now = useNow()
  const codex = !!session.codexMode
  const claudeProfiles = useClaudeProfileStore((s) => s.profiles)
  const codexAccounts = useCodexAccountStore((s) => s.accounts)
  const own = codex ? sessionCodexAccount(session) : sessionAccount(session)
  const auth = codex
    ? describeCodexAccountAuth(getCodexAccount(own.removed ? undefined : own.id))
    : describeClaudeProfileAuth(getClaudeProfile(own.removed ? undefined : own.id))
  const claudeSummary = useClaudeAccountsUsage((s) => s.byAccount[own.id])
  const codexSummary = useCodexAccountsUsage((s) => s.byAccount[own.id])
  // The session's view of its account: the shared caps and its own family's.
  const summary = claudeUsageForModel(codex ? codexSummary : claudeSummary, session.model)
  const status = capStatus(summary, { now })
  const exhausted = status?.exhausted === true
  // Out: the cap that stops this session, named with its return, then what
  // the account still has for the other models. Open: the headroom, then
  // when its week renews, which is what ranks the pool.
  const weekly = soonestWeeklyReset(summary)
  const renews =
    weekly != null
      ? formatReset(weekly)?.replace(/^resets/, 'week renews')
      : summary?.tightest
        ? formatReset(summary.tightest.resetsAt)
        : null
  const line2 = status
    ? exhausted
      ? [...status.out, status.headroom].filter(Boolean).join(' · ')
      : [status.headroom, ...status.out, renews].filter(Boolean).join(' · ')
    : null
  const single = (codex ? codexAccounts : claudeProfiles).length <= 1
  const Logo = codex ? CodexLogo : ClaudeLogo
  const line = (
    <div
      className="flex items-center gap-2 min-w-0"
      data-claude-account-header={codex ? undefined : own.id}
      data-account-header={own.id}
      data-account-provider={codex ? 'codex' : 'claude'}
      data-account-exhausted={exhausted ? 'true' : undefined}
    >
      <Logo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
      <div className="min-w-0">
        <div className="text-xs text-text-primary truncate">
          {single && !own.removed ? (codex ? 'Codex account' : 'Claude account') : own.label}
          <span className="text-text-tertiary"> · {own.removed ? 'removed account' : auth}</span>
        </div>
        <div className="text-[11px] text-text-tertiary truncate tabular-nums">
          {line2 ? line2 : summary?.status === 'error' ? 'Usage unavailable' : 'Reading usage…'}
        </div>
      </div>
    </div>
  )
  if (!chart) return line
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      {line}
      <AccountUsageBars summary={summary} now={now} />
    </div>
  )
}
