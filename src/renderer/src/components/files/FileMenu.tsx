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
  onSelect: () => void | Promise<void>
  disabled?: boolean
  /** Said on the row before the menu closes, for an action nothing on screen shows (a copy). */
  done?: string
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
  actions = []
}: {
  views?: FileViewMode[]
  view?: FileViewMode
  onView?: (mode: FileViewMode) => void
  actions?: FileMenuAction[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState<string | null>(null)
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
          aria-label="File menu"
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
          aria-label="File menu"
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
          {actions.map((action) => (
            <DropdownMenu.Item
              key={action.id}
              className="menu-item"
              disabled={action.disabled}
              onSelect={(event) => {
                if (!action.done) {
                  void action.onSelect()
                  return
                }
                event.preventDefault()
                void Promise.resolve(action.onSelect()).then(() => {
                  setDone(action.id)
                  timer.current = setTimeout(() => setOpen(false), DONE_MS)
                })
              }}
            >
              <action.icon className="menu-glyph" />
              <span className="flex-1 truncate">{action.label}</span>
              {done === action.id && (
                <span className="menu-hint session-menu-note" data-tone="done">
                  <CheckIcon className="w-3 h-3" />
                  {action.done}
                </span>
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
