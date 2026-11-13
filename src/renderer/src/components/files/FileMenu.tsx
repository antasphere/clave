import { useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@clave/ui/primitives/dropdown-menu'
import {
  CheckIcon,
  CodeBracketIcon,
  DocumentTextIcon,
  EllipsisHorizontalIcon,
  GlobeAltIcon
} from '@heroicons/react/24/outline'
import { VIEW_LABELS, type FileViewMode } from './file-types'

/** A row of the menu that does something with the file. */
export interface FileMenuAction {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  /** A string answered is said on the row before the menu closes (Saved as v4). */
  onSelect: () => void | string | Promise<void | string>
  disabled?: boolean
  /** Said on the row before the menu closes, for an action nothing on screen shows (a copy). */
  done?: string
  /** The row waits for its action and says what it answered, or why it failed. */
  reports?: boolean
  /** A divider above the row: it starts a group of its own. */
  separated?: boolean
}

const VIEW_ICONS: Record<FileViewMode, React.ComponentType<{ className?: string }>> = {
  page: DocumentTextIcon,
  rendered: GlobeAltIcon,
  source: CodeBracketIcon
}

/** How long a row's note stays in sight before the menu closes itself. */
const DONE_MS = 700

/**
 * The ⋯ menu on a file's bar (PRDCT-4491), the session menu's counterpart: how the file reads
 * (its views) and what can be done with it. The views used to be a segmented switch in the
 * bar, which made a file's bar taller than a session's; in here, the bar stays one control
 * tall, as the session's does.
 */
export function FileMenu({
  views = [],
  view,
  onView,
  actions = [],
  label = 'File menu'
}: {
  views?: FileViewMode[]
  view?: FileViewMode
  onView?: (mode: FileViewMode) => void
  actions?: FileMenuAction[]
  /** What the ⋯ button and its menu are called. */
  label?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState<{ id: string; text: string; failed?: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const choosable = views.length > 1 && !!onView
  return (
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setDone(null)
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="panel-icon-btn"
          aria-label={label}
          title="View and actions"
          data-view={view ?? ''}
          data-active={open ? 'true' : undefined}
        >
          <EllipsisHorizontalIcon className="w-4 h-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          className="menu-surface menu-pop z-50 min-w-[12rem] p-1"
          aria-label={label}
        >
          {choosable && (
            <>
              <DropdownMenu.Label className="menu-label">View as</DropdownMenu.Label>
              {views.map((mode) => {
                const Icon = VIEW_ICONS[mode]
                return (
                  <DropdownMenu.Item
                    key={mode}
                    className="menu-item"
                    data-selected={mode === view ? 'true' : undefined}
                    onSelect={() => onView(mode)}
                  >
                    <Icon className="menu-glyph" />
                    <span className="flex-1 truncate">{VIEW_LABELS[mode]}</span>
                  </DropdownMenu.Item>
                )
              })}
            </>
          )}
          {choosable && actions.length > 0 && <DropdownMenu.Separator className="menu-sep" />}
          {actions.map((action, index) => [
            action.separated && index > 0 && (
              <DropdownMenu.Separator key={`${action.id}-sep`} className="menu-sep" />
            ),
            <DropdownMenu.Item
              key={action.id}
              className="menu-item"
              disabled={action.disabled}
              onSelect={(event) => {
                if (!action.done && !action.reports) {
                  void action.onSelect()
                  return
                }
                event.preventDefault()
                void Promise.resolve()
                  .then(() => action.onSelect())
                  .then(
                    (said) => {
                      const text = typeof said === 'string' ? said : (action.done ?? '')
                      setDone({ id: action.id, text })
                      timer.current = setTimeout(() => setOpen(false), DONE_MS * (text ? 2 : 1))
                    },
                    (error: unknown) =>
                      setDone({
                        id: action.id,
                        text: error instanceof Error ? error.message : String(error),
                        failed: true
                      })
                  )
              }}
            >
              <action.icon className="menu-glyph" />
              <span className="flex-1 truncate">{action.label}</span>
              {done?.id === action.id && done.text && (
                <span
                  className="menu-hint session-menu-note"
                  data-tone={done.failed ? 'failed' : 'done'}
                  title={done.text}
                >
                  {!done.failed && <CheckIcon className="w-3 h-3" />}
                  {done.text}
                </span>
              )}
            </DropdownMenu.Item>
          ])}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
