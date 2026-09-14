import { ClaudeLogo } from '../icons/cli-logos'
import {
  useClaudeProfileStore,
  getClaudeProfile,
  describeClaudeProfileAuth
} from '../../store/claude-profile-store'
import { useClaudeAccountsUsage, headroomLabel, formatReset } from '../../store/usage-store'

/**
 * The header of a Claude session's context menu: which account the session
 * runs on and that account's headroom. Live while the menu is open: a read
 * that lands meanwhile updates the line.
 */
export function ClaudeAccountMenuHeader({
  accountId
}: {
  accountId: string | undefined
}): React.JSX.Element {
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const account = getClaudeProfile(accountId)
  const summary = useClaudeAccountsUsage((s) => s.byAccount[account.id])
  const headroom = headroomLabel(summary)
  const reset = summary?.tightest ? formatReset(summary.tightest.resetsAt) : null
  const single = profiles.length <= 1
  return (
    <div className="flex items-center gap-2 min-w-0" data-claude-account-header={account.id}>
      <ClaudeLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
      <div className="min-w-0">
        <div className="text-xs text-text-primary truncate">
          {single ? 'Claude account' : account.label}
          <span className="text-text-tertiary"> · {describeClaudeProfileAuth(account)}</span>
        </div>
        <div className="text-[11px] text-text-tertiary truncate tabular-nums">
          {headroom
            ? [headroom, reset].filter(Boolean).join(' · ')
            : summary?.status === 'error'
              ? 'Usage unavailable'
              : 'Reading usage…'}
        </div>
      </div>
    </div>
  )
}
