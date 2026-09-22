import { prereleaseLabel } from '../../../../shared/version'
import { cn } from '../../lib/utils'

/**
 * The mark next to a pre-release version, wherever one is named: the running
 * version in Software Update, the version on offer in the sidebar's update
 * prompt. One component so the two cannot drift. Renders nothing for a
 * stable version, so callers pass the version and let the mark decide.
 */
export function PrereleaseMark({
  version,
  className
}: {
  version: string | null
  className?: string
}): React.JSX.Element | null {
  const label = version ? prereleaseLabel(version) : null
  if (!label) return null
  return (
    <span
      data-testid="prerelease-mark"
      className={cn('badge badge-uppercase bg-accent/12 text-accent flex-shrink-0', className)}
    >
      {label}
    </span>
  )
}
