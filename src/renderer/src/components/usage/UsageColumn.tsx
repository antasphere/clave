import type { ReactElement } from 'react'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { Tooltip, TooltipContent, TooltipTrigger } from '@clave/ui/components'
import type { UsageWindow } from '../../../../preload/index.d'
import { capLevel, columnLabel, formatResetAt, formatResetIn } from '../../store/usage-store'

/** One cap as a column: the percent used over it, the track the height of
 *  the whole cap, the fill anchored to its floor, the cap's name and its
 *  reset under it. The tooltip carries the full sentence; a column drawn
 *  where nothing can be hovered (the account preview) goes without. */
export function UsageColumn({
  window: w,
  now,
  tooltip = true
}: {
  window: UsageWindow
  now: number
  tooltip?: boolean
}): ReactElement {
  const pct = Math.round(w.usedPercentage)
  const level = capLevel(w)
  const at = formatResetAt(w.resetsAt)
  const inTime = formatResetIn(w.resetsAt, now)
  const full = w.usedPercentage >= 100
  const column = (
    <div
      className="usage-column"
      data-usage-window={w.key}
      data-level={level}
      tabIndex={tooltip ? 0 : undefined}
    >
      <span className="usage-column-value" aria-label={`${pct}% used`}>
        {level === 'critical' && <ExclamationTriangleIcon aria-hidden />}
        {pct}%
      </span>
      <span className="usage-column-track">
        <span
          className={`usage-column-fill usage-meter-fill--${level}`}
          style={{ height: `${Math.min(100, Math.max(w.usedPercentage, pct === 0 ? 0 : 3))}%` }}
        />
      </span>
      <span className="usage-column-label">{columnLabel(w)}</span>
      {inTime && <span className="usage-column-reset">{inTime}</span>}
    </div>
  )
  if (!tooltip) return column
  return (
    <Tooltip>
      <TooltipTrigger asChild>{column}</TooltipTrigger>
      <TooltipContent side="top">
        <div className="font-medium">{w.label}</div>
        <div>
          {pct}% used{full ? ' — limit reached' : ''}
        </div>
        {at && (
          <div className="text-text-tertiary">
            Resets {at} ({inTime})
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
