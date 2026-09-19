import { useCallback, useEffect, useRef, useState, memo } from 'react'
import { cn } from '@clave/ui/components'
import {
  useSessionStore,
  type SessionGroup,
  resolveColorHex
} from '../../store/session-store'
import {
  FolderIcon,
  FolderOpenIcon,
  CommandLineIcon,
  PlusIcon
} from '@heroicons/react/24/outline'
import { Popover, PopoverAnchor, PopoverContent } from '@clave/ui/components'
import { GroupTerminalsPanel } from './GroupTerminalsPanel'
import { useInlineEdit } from '../../hooks/use-inline-edit'

/** Hover-to-open timing for the terminals panel: a short wait so a cursor
 *  passing over the icon does not pop it, and a longer grace on leave so the
 *  hand can travel from the icon into the panel across the gap. */
const PANEL_OPEN_DELAY = 140
const PANEL_CLOSE_DELAY = 240
/** Air between the sidebar's edge and the panel. */
const PANEL_GAP = 6

interface SessionGroupItemProps {
  group: SessionGroup
  onClick: (modifiers: { metaKey: boolean; shiftKey: boolean }) => void
  onContextMenu: (e: React.MouseEvent) => void
  onTerminalIconClick: (terminalId: string) => void
  onTerminalIconContextMenu: (terminalId: string, e: React.MouseEvent) => void
  onAddTerminalClick: () => void
  /** The header's `+`: a new session inside this group, on the group's prompt. */
  onNewSession: () => void
  /** What the `+` will do, for its tooltip (whether the group's prompt applies). */
  newSessionTitle: string
  aliveSessionIds: Set<string>
  focusedSessionId: string | null
  allSelected?: boolean
  /** Fades the group header when the group is not the active selection */
  dimmed?: boolean
  forceEditing?: boolean
  onEditingDone?: () => void
  onPointerDown?: (e: React.PointerEvent) => void
  isDragging?: boolean
  /** Any sidebar drag in flight: the terminals panel must not pop under a
   *  dragged row passing over its icon. */
  dragActive?: boolean
}

function SessionGroupItemImpl({
  group,
  onClick,
  onContextMenu,
  onTerminalIconClick,
  onTerminalIconContextMenu,
  onAddTerminalClick,
  onNewSession,
  newSessionTitle,
  aliveSessionIds,
  focusedSessionId,
  allSelected,
  dimmed,
  forceEditing,
  onEditingDone,
  onPointerDown,
  isDragging,
  dragActive
}: SessionGroupItemProps): React.JSX.Element {
  const toggleGroupCollapsed = useSessionStore((s) => s.toggleGroupCollapsed)
  const renameGroup = useSessionStore((s) => s.renameGroup)

  const {
    editing,
    editValue,
    inputRef,
    setEditValue,
    handleButtonKeyDown,
    handleInputKeyDown,
    commitRename
  } = useInlineEdit({
    name: group.name,
    onCommit: (newName) => renameGroup(group.id, newName),
    onEditingDone,
    forceEditing
  })

  const handleToggleCollapse = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      toggleGroupCollapsed(group.id)
    },
    [group.id, toggleGroupCollapsed]
  )

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      onClick({ metaKey: e.metaKey, shiftKey: e.shiftKey })
    },
    [onClick]
  )

  // ── The terminals panel: opens on hovering its icon (or a click), closes
  // when the cursor has left both the icon and the panel. One timer serves
  // both directions so a quick leave-and-return never flickers it.
  const [panelOpen, setPanelOpen] = useState(false)
  const panelTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The panel is anchored to the terminals button but placed against the
  // GROUP: out past the sidebar's right edge, and level with the top of the
  // group's own row. The button is neither — it sits a row's padding in from
  // the edge and is centred in a row taller than itself — so both offsets are
  // measured from the elements around it each time the panel opens (the
  // sidebar resizes, and the row moves as the list scrolls).
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [panelOffset, setPanelOffset] = useState({ side: PANEL_GAP, align: 0 })
  const measurePanelOffset = useCallback(() => {
    const btn = anchorRef.current
    const shell = btn?.closest('[data-sidebar-shell]')
    const row = btn?.closest('[data-sidebar-item-type="group"]')
    if (!btn || !shell || !row) return
    const b = btn.getBoundingClientRect()
    setPanelOffset({
      side: Math.max(PANEL_GAP, shell.getBoundingClientRect().right - b.right + PANEL_GAP),
      // Negative: the row starts above the button centred inside it.
      align: row.getBoundingClientRect().top - b.top
    })
  }, [])
  const clearPanelTimer = useCallback(() => {
    if (panelTimer.current) {
      clearTimeout(panelTimer.current)
      panelTimer.current = null
    }
  }, [])
  const scheduleOpen = useCallback(() => {
    if (dragActive) return
    clearPanelTimer()
    panelTimer.current = setTimeout(() => {
      measurePanelOffset()
      setPanelOpen(true)
    }, PANEL_OPEN_DELAY)
  }, [dragActive, clearPanelTimer, measurePanelOffset])
  const scheduleClose = useCallback(() => {
    clearPanelTimer()
    panelTimer.current = setTimeout(() => setPanelOpen(false), PANEL_CLOSE_DELAY)
  }, [clearPanelTimer])
  useEffect(() => clearPanelTimer, [clearPanelTimer])
  // A drag in flight hides the panel (derived, so no effect has to close it);
  // the cursor left the icon to start the drag, so the close timer is already
  // running and the state settles on its own.
  const panelShown = panelOpen && !dragActive

  const terminals = group.terminals
  const runningTerminals = terminals.filter(
    (t) => !!t.sessionId && aliveSessionIds.has(t.sessionId)
  )
  const litColor = runningTerminals.length
    ? (resolveColorHex(runningTerminals[0].color) ?? undefined)
    : undefined
  const terminalFocused = terminals.some(
    (t) => !!t.sessionId && t.sessionId === focusedSessionId
  )

  // Two different fades, deliberately not the same element. Dragging fades the
  // whole row. "Not the active selection" fades only the header's own folder and
  // name (0.45, a touch more than its tabs' 0.55, so a dimmed header reads
  // differently from a dimmed tab) — and NOT the controls beside them. The
  // terminals button is the one thing worth reading in a group you are not
  // looking at: whether something is running, and how many there are.
  const dragOpacity = isDragging ? 0.3 : undefined
  const labelOpacity = dimmed ? 0.45 : undefined
  const labelStyle = labelOpacity !== undefined ? { opacity: labelOpacity } : undefined

  return (
    <div
      className="relative"
      data-sidebar-item-id={group.id}
      data-sidebar-item-type="group"
      onPointerDown={!editing ? onPointerDown : undefined}
    >
      <button
        onClick={handleClick}
        onContextMenu={onContextMenu}
        onKeyDown={handleButtonKeyDown}
        className={cn(
          'group group-header w-full flex items-center gap-2 px-[var(--sidebar-row-px)] h-[var(--sidebar-row-h)] rounded-lg text-left transition-[color,opacity] outline-none',
          allSelected ? 'text-text-primary' : 'text-text-secondary'
        )}
        style={dragOpacity !== undefined ? { opacity: dragOpacity } : undefined}
      >
        {/* Folder disclosure — open when expanded, closed when collapsed */}
        <span
          onClick={handleToggleCollapse}
          className="sidebar-tab-icon flex-shrink-0 flex items-center justify-center cursor-pointer"
          style={labelStyle}
        >
          {group.collapsed ? (
            <FolderIcon />
          ) : (
            <FolderOpenIcon />
          )}
        </span>

        {/* Group name */}
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleInputKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 bg-transparent text-[13px] font-medium text-text-primary outline-none border-none"
          />
        ) : (
          <span
            className="flex-1 min-w-0 text-[13px] font-medium truncate"
            style={labelStyle}
          >
            {group.name}
          </span>
        )}

        {/* Two controls, always the same two, whatever the terminal count: the
            `+` for a new session, then the terminals button (count + icon, lit
            while one runs, the panel on hover). The `+` leads because it is the
            one you reach for without reading — the terminals button is the one
            you read first, so it sits at the edge where the count lands next to
            the icon it counts. The row used to lay every terminal's icon out
            here and ran off the sidebar past a handful (PRDCT-1670). */}
        <div className={cn('flex items-center gap-0.5 flex-shrink-0', editing && 'invisible')}>
          <span
            role="button"
            tabIndex={-1}
            aria-label={`New session in ${group.name}`}
            className="btn-icon btn-icon-xs group-new-session"
            title={newSessionTitle}
            onClick={(e) => {
              e.stopPropagation()
              onNewSession()
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <PlusIcon className="w-4 h-4" />
          </span>
          <Popover open={panelShown} onOpenChange={setPanelOpen}>
            <PopoverAnchor asChild>
              <span
                ref={anchorRef}
                role="button"
                tabIndex={-1}
                aria-label={`Terminals of ${group.name}`}
                aria-expanded={panelShown}
                data-group-terminals
                data-running={runningTerminals.length > 0 ? 'true' : undefined}
                className={cn(
                  'group-terminals-btn btn-icon btn-icon-xs',
                  terminalFocused && 'group-terminals-btn--focused',
                  panelShown && 'group-terminals-btn--open'
                )}
                style={litColor ? { color: litColor } : undefined}
                title={
                  terminals.length === 0
                    ? 'Terminals — none yet'
                    : `${runningTerminals.length} of ${terminals.length} terminal${terminals.length > 1 ? 's' : ''} running`
                }
                onMouseEnter={scheduleOpen}
                onMouseLeave={scheduleClose}
                onClick={(e) => {
                  e.stopPropagation()
                  clearPanelTimer()
                  measurePanelOffset()
                  // Opens, never toggles: hover has usually opened it already by
                  // the time the click lands, and a click that closed what you
                  // were reaching for read as the panel refusing to open.
                  setPanelOpen(true)
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {terminals.length > 0 && (
                  <span className="group-terminals-count tabular-nums">{terminals.length}</span>
                )}
                <CommandLineIcon className="w-4 h-4" />
              </span>
            </PopoverAnchor>
            {/* To the RIGHT of the sidebar and level with the group's row, not
                down into the list: the panel lists a dozen terminals with
                their commands and folders, which is wider than the sidebar and
                taller than the rows below it — opened downwards it covered the
                very groups you were choosing between. Near the bottom of the
                window it still slides up to stay on screen; that is the one
                case where its top is not the group's top. */}
            <PopoverContent
              side="right"
              align="start"
              sideOffset={panelOffset.side}
              alignOffset={panelOffset.align}
              className="p-0"
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
              onMouseEnter={clearPanelTimer}
              onMouseLeave={scheduleClose}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <GroupTerminalsPanel
                terminals={terminals}
                aliveSessionIds={aliveSessionIds}
                focusedSessionId={focusedSessionId}
                onTerminalClick={(tid) => {
                  setPanelOpen(false)
                  onTerminalIconClick(tid)
                }}
                onTerminalContextMenu={(tid, e) => {
                  setPanelOpen(false)
                  onTerminalIconContextMenu(tid, e)
                }}
                onAddTerminal={() => {
                  setPanelOpen(false)
                  onAddTerminalClick()
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
      </button>
    </div>
  )
}

// `aliveSessionIds` is a fresh Set whenever any session changes, so we can't
// compare it by reference. Instead, compare alive-membership only for the ids
// this group actually references (its sessions + each terminal's bound session).
// Function props are stable live handlers (see SessionItem) and are ignored.
export const SessionGroupItem = memo(SessionGroupItemImpl, (prev, next) => {
  if (
    prev.group !== next.group ||
    prev.focusedSessionId !== next.focusedSessionId ||
    prev.allSelected !== next.allSelected ||
    prev.dimmed !== next.dimmed ||
    prev.forceEditing !== next.forceEditing ||
    prev.isDragging !== next.isDragging ||
    prev.dragActive !== next.dragActive ||
    prev.newSessionTitle !== next.newSessionTitle
  ) {
    return false
  }
  const relevantIds = [
    ...next.group.sessionIds,
    ...next.group.terminals.map((t) => t.sessionId).filter((id): id is string => !!id)
  ]
  for (const id of relevantIds) {
    if (prev.aliveSessionIds.has(id) !== next.aliveSessionIds.has(id)) return false
  }
  return true
})
