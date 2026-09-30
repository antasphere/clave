import type { ReactElement } from 'react'
import { SparklesIcon } from '@heroicons/react/24/outline'
import {
  useClaudeAccountsUsage,
  useCodexAccountsUsage,
  headroomWindow,
  capName,
  capLevel,
  formatResetAt,
  formatResetIn,
  type AccountUsageSummary
} from '../../store/usage-store'
import { isExhausted, soonestWeeklyReset } from '../../lib/account-pool'
import { useNow } from '../../lib/use-now'
import type { SwitchTarget } from '../../lib/switch-account'
import { UsageColumn } from '../usage/UsageColumn'

/**
 * The Switch account submenu, one row per account the tab could move to,
 * and the card beside it while a row is highlighted. The row answers "which
 * one": what is left, when its week renews, and which the pool would spend
 * first (SUGGESTED: the open account that renews soonest, so no headroom
 * expires unused). The card answers "left of what": every cap of the account
 * as the Usage page draws it, so a Fable cap at zero does not hide that the
 * other models still have room. Both read the live usage, so a read that
 * lands while the menu is open updates them.
 */

function useTargetSummary(target: SwitchTarget): AccountUsageSummary | undefined {
  const claude = useClaudeAccountsUsage((s) => s.byAccount[target.id])
  const codex = useCodexAccountsUsage((s) => s.byAccount[target.id])
  return (target.provider === 'codex' ? codex : claude) ?? target.summary
}

export function AccountSwitchRow({ target }: { target: SwitchTarget }): ReactElement {
  const now = useNow()
  const summary = useTargetSummary(target)
  const w = headroomWindow(summary)
  const exhausted = isExhausted(summary)
  const level = w ? capLevel(w) : 'normal'
  const left = w ? Math.max(0, Math.round(100 - w.usedPercentage)) : null
  const weekly = formatResetIn(soonestWeeklyReset(summary), now)
  // An account at its limit is worth knowing about by when it comes back,
  // which is the reset of the cap that stopped it, not the week's.
  const back = exhausted ? formatResetIn(summary?.tightest?.resetsAt ?? null, now) : null
  const detail = back
    ? `Back ${back}`
    : weekly
      ? `Week renews ${weekly}`
      : summary?.status === 'error'
        ? 'Usage unavailable'
        : summary?.tightest
          ? 'No weekly reset reported'
          : 'Reading usage…'
  return (
    <span
      className="account-switch-row"
      data-account-switch-row={target.id}
      data-exhausted={exhausted ? 'true' : undefined}
      data-suggested={target.suggested ? 'true' : undefined}
      data-level={exhausted ? 'critical' : w ? level : 'unknown'}
    >
      <span className="account-switch-dot" aria-hidden />
      <span className="account-switch-main">
        <span className="account-switch-name">
          <span className="truncate">{target.label}</span>
          {target.suggested && (
            <span className="badge account-switch-suggested">
              <SparklesIcon aria-hidden />
              Suggested
            </span>
          )}
        </span>
        <span className="account-switch-detail">{detail}</span>
      </span>
      {w && left != null && (
        <span className="account-switch-headroom">
          <span className="account-switch-left">{exhausted ? 'At limit' : `${left}% left`}</span>
          <span className="account-switch-cap">{capName(w)}</span>
        </span>
      )}
    </span>
  )
}

/** The card beside a highlighted row: every cap of the account as columns on
 *  the Usage page's 0–100% scale, the weekly ones first, then the 5-hour
 *  block, and the date its week renews. */
export function AccountUsagePreview({ target }: { target: SwitchTarget }): ReactElement {
  const now = useNow()
  const summary = useTargetSummary(target)
  const windows = summary?.status === 'error' ? [] : (summary?.windows ?? [])
  const weekly = windows.filter((w) => w.kind !== 'session')
  const session = windows.filter((w) => w.kind === 'session')
  const renews = soonestWeeklyReset(summary)
  return (
    <div className="account-preview" data-account-preview={target.id}>
      <div className="account-preview-head">
        <span className="account-preview-name">{target.label}</span>
        {target.auth !== target.label && (
          <span className="account-preview-meta">{target.auth}</span>
        )}
      </div>
      {windows.length > 0 ? (
        <div className="account-preview-plot" data-usage-chart="preview">
          {weekly.map((w) => (
            <UsageColumn key={w.key} window={w} now={now} tooltip={false} />
          ))}
          {weekly.length > 0 && session.length > 0 && (
            <span className="account-preview-divider" aria-hidden />
          )}
          {session.map((w) => (
            <UsageColumn key={w.key} window={w} now={now} tooltip={false} />
          ))}
        </div>
      ) : (
        <div className="account-preview-empty">
          {summary?.status === 'error'
            ? 'Usage could not be read'
            : summary?.status === 'ready'
              ? (summary.message ?? 'No limits reported')
              : 'Reading usage…'}
        </div>
      )}
      <div className="account-preview-foot">
        % used
        {renews && (
          <>
            {' · Week renews '}
            <span className="text-text-secondary">{formatResetAt(renews)}</span>
          </>
        )}
      </div>
    </div>
  )
}
