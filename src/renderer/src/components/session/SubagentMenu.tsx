import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import type { Session } from '../../store/session-types'
import { tabIndicators } from '../../lib/tab-status'

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

export function SubagentMenu({
  parent,
  descendants,
  selectedIds,
  focusedId,
  onSelect
}: {
  parent: Session
  descendants: Session[]
  selectedIds: string[]
  focusedId: string | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  const selected = descendants.filter((s) => selectedIds.includes(s.id))
  const current = selected.find((s) => s.id === focusedId) ?? selected[0]
  const label = current
    ? `${current.name}${selected.length > 1 ? ` +${selected.length - 1}` : ''}`
    : `${descendants.length} ${descendants.length === 1 ? 'agent' : 'agents'}`
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="chat-model-trigger subagent-trigger"
          data-active={selected.length > 0 ? 'true' : undefined}
          aria-label={`Subagents of ${parent.name}${current ? `, selected ${label}` : ''}`}
          title={`${descendants.length} subagents${current ? ` · ${label}` : ''}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="chat-model-trigger-label">{label}</span>
          <ChevronDownIcon aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="start"
          sideOffset={6}
          className="menu-surface menu-pop chat-model-menu subagent-menu z-50"
          aria-label={`Sessions spawned by ${parent.name}`}
          // A newly selected terminal can finish mounting after this menu opens.
          // Its programmatic focus must not dismiss a menu the user is using.
          onFocusOutside={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <DropdownMenu.Label className="menu-label">Session and subagents</DropdownMenu.Label>
          {[parent, ...descendants].map((session, index) => (
            <DropdownMenu.Item
              key={session.id}
              className="menu-item chat-model-option"
              data-selected={selectedIds.includes(session.id) ? 'true' : undefined}
              aria-current={selectedIds.includes(session.id) ? 'true' : undefined}
              onSelect={() => onSelect(session.id)}
              textValue={session.name}
            >
              <span className="chat-model-option-text">
                <span className="truncate">{session.name}</span>
                <span className="chat-model-option-hint">
                  {index === 0 ? 'Back to parent · ' : ''}
                  {stateLabel(session)}
                </span>
              </span>
              {selectedIds.includes(session.id) && (
                <CheckIcon className="select-option-check" aria-hidden="true" />
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
