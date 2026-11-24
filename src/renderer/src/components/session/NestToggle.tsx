import { ChevronRightIcon } from '@heroicons/react/24/outline'
import type { Session } from '../../store/session-types'
import { tabIndicators } from '../../lib/tab-status'
import { subagentAttention } from '../../lib/subagent-presentation'

/** A nested tab's state in words, for the toggle's label. */
function stateLabel(session: Session): string {
  const status = tabIndicators(session).status
  return {
    'needs-you': 'Waiting on you',
    working: 'Working',
    unread: 'New activity',
    idle: session.agentState === 'done' ? 'Done' : 'Idle',
    ended: 'Ended'
  }[status]
}

/**
 * The quiet count on a tab's row that folds and unfolds the tabs nested under
 * it (PRDCT-4998), just before the row's status. Folded, it takes the colour
 * of the nested tab that most asks for attention (the stylesheet reads
 * `data-status` only then), and a nest at work shows the spinner in the
 * chevron's place: a folded row still says what is going on under it.
 * Unfolded, the rows speak for themselves and the count is a plain control.
 * A span inside the row's button, not a button: the row
 * already is one, so a click, Enter or Space here never reaches the row, and
 * a press never starts a drag.
 */
export function NestToggle({
  parent,
  nested,
  open,
  onToggle
}: {
  parent: Session
  nested: Session[]
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const attention = subagentAttention(nested)
  const alert = attention.sessions.map((s) => `${s.name}: ${stateLabel(s)}`).join('; ')
  const label = `${nested.length} ${nested.length === 1 ? 'tab' : 'tabs'} nested under ${parent.name}${alert ? `; ${alert}` : ''}`
  const toggle = (e: React.SyntheticEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    onToggle()
  }
  return (
    <span
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={label}
      title={label}
      className="sidebar-nest-toggle"
      data-open={open ? 'true' : undefined}
      data-status={attention.status}
      onClick={toggle}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        toggle(e)
      }}
    >
      {!open && attention.status === 'working' ? (
        <span className="sidebar-tab-spinner" aria-hidden="true" />
      ) : (
        <ChevronRightIcon aria-hidden="true" />
      )}
      <span className="sidebar-nest-count">{nested.length}</span>
    </span>
  )
}
