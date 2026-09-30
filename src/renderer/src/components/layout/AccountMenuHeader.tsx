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
  headroomLabel,
  formatReset
} from '../../store/usage-store'
import { isExhausted, soonestWeeklyReset } from '../../lib/account-pool'
import type { Session } from '../../store/session-types'

/**
 * The header of a Claude or Codex session's context menu: which account the
 * session runs on and that account's headroom. Live while the menu is open:
 * a read that lands meanwhile updates the line.
 */
export function AccountMenuHeader({ session }: { session: Session }): React.JSX.Element {
  const codex = !!session.codexMode
  const claudeProfiles = useClaudeProfileStore((s) => s.profiles)
  const codexAccounts = useCodexAccountStore((s) => s.accounts)
  const own = codex ? sessionCodexAccount(session) : sessionAccount(session)
  const auth = codex
    ? describeCodexAccountAuth(getCodexAccount(own.removed ? undefined : own.id))
    : describeClaudeProfileAuth(getClaudeProfile(own.removed ? undefined : own.id))
  const claudeSummary = useClaudeAccountsUsage((s) => s.byAccount[own.id])
  const codexSummary = useCodexAccountsUsage((s) => s.byAccount[own.id])
  const summary = codex ? codexSummary : claudeSummary
  const headroom = headroomLabel(summary)
  const exhausted = isExhausted(summary)
  // At its limit the question is when it comes back (the stopping cap's
  // reset); otherwise when its week renews, which is what ranks the pool.
  const weekly = soonestWeeklyReset(summary)
  const reset = exhausted
    ? summary?.tightest
      ? formatReset(summary.tightest.resetsAt)
      : null
    : weekly != null
      ? formatReset(weekly)?.replace(/^resets/, 'week renews')
      : summary?.tightest
        ? formatReset(summary.tightest.resetsAt)
        : null
  const single = (codex ? codexAccounts : claudeProfiles).length <= 1
  const Logo = codex ? CodexLogo : ClaudeLogo
  return (
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
          {headroom
            ? [headroom, reset, exhausted ? 'at limit' : null].filter(Boolean).join(' · ')
            : summary?.status === 'error'
              ? 'Usage unavailable'
              : 'Reading usage…'}
        </div>
      </div>
    </div>
  )
}
