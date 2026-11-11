import type { ReactElement } from 'react'
import { SparklesIcon } from '@heroicons/react/24/outline'
import {
  headroomWindow,
  capName,
  capLevel,
  capStatus,
  formatResetAt,
  formatResetIn,
  claudeUsageForModel,
  type AccountUsageSummary
} from '../../store/usage-store'
import { soonestWeeklyReset } from '../../lib/account-pool'
import { useNow } from '../../lib/use-now'
import type { SwitchTarget } from '../../lib/switch-account'
import { useOwnerAccountView } from '../../lib/session-accounts'
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
  // The target's OWNER's usage: a server tab's targets are the server's.
  const live = useOwnerAccountView(target.owner, target.provider).usage[target.id]
  return live ? claudeUsageForModel(live, target.model) : target.summary
}

export function AccountSwitchRow({ target }: { target: SwitchTarget }): ReactElement {
  const now = useNow()
  const summary = useTargetSummary(target)
  const status = capStatus(summary, { now })
  const w = headroomWindow(summary)
  const exhausted = status?.exhausted === true
  const level = w ? capLevel(w) : 'normal'
  const left = w ? Math.max(0, Math.round(100 - w.usedPercentage)) : null
  const weekly = formatResetIn(soonestWeeklyReset(summary), now)
  // An account that is out for this tab is worth knowing about by when the
  // cap that stopped it comes back ("Back in 2d 5h"; the badge names the
  // cap), never by the week's renewal; the shared headroom beside it says
  // what the account still has for the other models.
  const back = status?.stopping ? formatResetIn(status.stopping.resetsAt, now) : null
  const detail = exhausted
    ? [back ? `Back ${back}` : null, status?.headroom].filter(Boolean).join(' · ')
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
          <span className="account-switch-left">
            {status?.stopping ? `${capName(status.stopping)} out` : `${left}% left`}
          </span>
          {!status?.stopping && <span className="account-switch-cap">{capName(w)}</span>}
        </span>
      )}
    </span>
  )
}

/** Every cap of an account as columns on the Usage page's 0–100% scale, the
 *  weekly ones first, then the 5-hour block. Drawn in the card beside a
 *  Switch account row and at the top of a tab's own context menu. */
export function AccountUsagePlot({
  summary,
  now,
  even = false
}: {
  summary: AccountUsageSummary | undefined
  now: number
  /** Columns spread at equal distances over the width, no divider between
   *  the weekly caps and the 5-hour block. */
  even?: boolean
}): ReactElement {
  const windows = summary?.status === 'error' ? [] : (summary?.windows ?? [])
  const weekly = windows.filter((w) => w.kind !== 'session')
  const session = windows.filter((w) => w.kind === 'session')
  if (windows.length === 0)
    return (
      <div className="account-preview-empty">
        {summary?.status === 'error'
          ? 'Usage could not be read'
          : summary?.status === 'ready'
            ? (summary.message ?? 'No limits reported')
            : 'Reading usage…'}
      </div>
    )
  return (
    <div
      className={even ? 'account-preview-plot account-preview-plot--even' : 'account-preview-plot'}
      data-usage-chart="preview"
    >
      {weekly.map((w) => (
        <UsageColumn key={w.key} window={w} now={now} tooltip={false} />
      ))}
      {!even && weekly.length > 0 && session.length > 0 && (
        <span className="account-preview-divider" aria-hidden />
      )}
      {session.map((w) => (
        <UsageColumn key={w.key} window={w} now={now} tooltip={false} />
      ))}
    </div>
  )
}

/** Every cap of an account as one thin horizontal bar each — name, bar, %
 *  used, time to reset on a single line — the weekly caps first, then the
 *  5-hour block. The tab menu's header draws this rather than the columns:
 *  the columns stood ~8rem tall over a menu whose rows are 1.75rem, and the
 *  header outweighed the menu it sat on. Same data, same urgency colours. */
export function AccountUsageBars({
  summary,
  now
}: {
  summary: AccountUsageSummary | undefined
  now: number
}): ReactElement {
  const windows = summary?.status === 'error' ? [] : (summary?.windows ?? [])
  if (windows.length === 0)
    return (
      <div className="account-usage-bars-empty">
        {summary?.status === 'error'
          ? 'Usage could not be read'
          : summary?.status === 'ready'
            ? (summary.message ?? 'No limits reported')
            : 'Reading usage…'}
      </div>
    )
  const ordered = [
    ...windows.filter((w) => w.kind !== 'session'),
    ...windows.filter((w) => w.kind === 'session')
  ]
  return (
    <div className="account-usage-bars" data-usage-chart="bars">
      {ordered.map((w) => {
        const pct = Math.round(w.usedPercentage)
        const level = capLevel(w)
        const reset = formatResetIn(w.resetsAt, now)
        return (
          <div
            key={w.key}
            className="account-usage-bar"
            data-usage-window={w.key}
            data-level={level}
            title={`${w.label} · ${pct}% used${reset ? ` · resets ${reset}` : ''}`}
          >
            <span className="account-usage-bar-name">{capName(w)}</span>
            <span className="account-usage-bar-track">
              <span
                className={`account-usage-bar-fill usage-meter-fill--${level}`}
                style={{
                  width: `${Math.min(100, Math.max(w.usedPercentage, pct === 0 ? 0 : 3))}%`
                }}
              />
            </span>
            <span className="account-usage-bar-pct" aria-label={`${pct}% used`}>
              {pct}%
            </span>
            <span className="account-usage-bar-reset">{reset ?? ''}</span>
          </div>
        )
      })}
    </div>
  )
}

/** The card beside a highlighted row: every cap of the account as columns on
 *  the Usage page's 0–100% scale, the weekly ones first, then the 5-hour
 *  block, and the date its week renews. */
export function AccountUsagePreview({ target }: { target: SwitchTarget }): ReactElement {
  const now = useNow()
  const summary = useTargetSummary(target)
  const renews = soonestWeeklyReset(summary)
  return (
    <div className="account-preview" data-account-preview={target.id}>
      <div className="account-preview-head">
        <span className="account-preview-name">{target.label}</span>
        {target.auth !== target.label && (
          <span className="account-preview-meta">{target.auth}</span>
        )}
      </div>
      <AccountUsagePlot summary={summary} now={now} />
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
