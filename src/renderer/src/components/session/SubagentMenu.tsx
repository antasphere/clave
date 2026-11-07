import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import type { Session } from '../../store/session-types'
import { tabIndicators } from '../../lib/tab-status'
import { subagentAttention } from '../../lib/subagent-presentation'

export type SessionMenuEvent = Pick<React.MouseEvent, 'preventDefault' | 'clientX' | 'clientY'>

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
  onSelect,
  onContextMenu
}: {
  parent: Session
  descendants: Session[]
  selectedIds: string[]
  focusedId: string | null
  onSelect: (id: string) => void
  onContextMenu?: (event: SessionMenuEvent, id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openingContext = useRef(false)
  const showContext = (event: SessionMenuEvent, id: string): void => {
    if (!onContextMenu) return
    openingContext.current = true
    setOpen(false)
    onContextMenu(event, id)
  }
  const selected = descendants.filter((s) => selectedIds.includes(s.id))
  const attention = subagentAttention(descendants)
  const alert = attention.sessions.map((s) => `${s.name}: ${stateLabel(s)}`).join('; ')
  const current = selected.find((s) => s.id === focusedId) ?? selected[0]
  const label = current
    ? `${current.name}${selected.length > 1 ? ` +${selected.length - 1}` : ''}`
    : `${descendants.length} ${descendants.length === 1 ? 'agent' : 'agents'}`
  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="chat-model-trigger subagent-trigger"
          data-active={selected.length > 0 ? 'true' : undefined}
          data-status={attention.status}
          aria-label={`Subagents of ${parent.name}${current ? `, selected ${label}` : ''}${alert ? `; ${alert}` : ''}`}
          title={`${descendants.length} ${descendants.length === 1 ? 'subagent' : 'subagents'}${current ? ` · ${label}` : ''}${alert ? ` · ${alert}` : ''}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {attention.status !== 'idle' && (
            <span className="tab-status relative" data-status={attention.status} aria-hidden="true">
              <UserGroupIcon />
            </span>
          )}
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
          onCloseAutoFocus={(event) => {
            if (openingContext.current) {
              event.preventDefault()
              openingContext.current = false
            }
          }}
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
              onContextMenu={(event) => showContext(event, session.id)}
              onKeyDown={(event) => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  showContext(
                    { preventDefault: () => {}, clientX: rect.right, clientY: rect.top },
                    session.id
                  )
                }
              }}
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
