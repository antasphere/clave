import { useCallback, type ReactNode } from 'react'
import { cn } from '@clave/ui/components'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useInlineEdit } from '../../hooks/use-inline-edit'

export interface SidebarTabItemProps {
  /** Unique identifier for this item */
  id: string
  /** Display name */
  name: string
  /** Tooltip text */
  title?: string
  /** Whether this item is currently selected */
  isSelected: boolean
  onClick: (modifiers: { metaKey: boolean; shiftKey: boolean }) => void
  onContextMenu: (e: React.MouseEvent) => void
  /** Called when the name is committed after editing */
  onRename: (id: string, newName: string) => void
  /** Called when the close button is clicked. If omitted, no close button is shown. */
  onDelete?: () => void

  // Icon slot
  icon: ReactNode
  /** Extra content rendered between the name and the close button (e.g. LocationBadge) */
  extraContent?: ReactNode

  // Group styling
  grouped?: boolean
  groupSelected?: boolean
  /** When set, applies tinted hover/selection backgrounds */
  groupColorHex?: string
  /** Fades the tab when another item is the active selection */
  dimmed?: boolean

  // Inline rename
  forceEditing?: boolean
  onEditingDone?: () => void

  // Drag and drop
  onPointerDown?: (e: React.PointerEvent) => void
  isDragging?: boolean
}

export function SidebarTabItem({
  id,
  name,
  title,
  isSelected,
  onClick,
  onContextMenu,
  onRename,
  onDelete,
  icon,
  extraContent,
  grouped,
  groupSelected,
  groupColorHex,
  dimmed,
  forceEditing,
  onEditingDone,
  onPointerDown,
  isDragging
}: SidebarTabItemProps) {
  const {
    editing,
    editValue,
    inputRef,
    setEditValue,
    handleDoubleClick,
    handleButtonKeyDown,
    handleInputKeyDown,
    commitRename
  } = useInlineEdit({
    name,
    onCommit: (newName) => onRename(id, newName),
    onEditingDone,
    forceEditing
  })

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      onClick({ metaKey: e.metaKey, shiftKey: e.shiftKey })
    },
    [onClick]
  )

  // Dragging takes visual priority; otherwise fade dimmed (unselected) tabs.
  const itemOpacity = isDragging ? 0.3 : dimmed ? 0.55 : undefined
  const tintBackground =
    groupColorHex && isSelected && !groupSelected && grouped
      ? `${groupColorHex}30`
      : undefined

  return (
    <div
      className="relative"
      data-sidebar-item-id={id}
      data-sidebar-item-type="session"
      onPointerDown={!editing ? onPointerDown : undefined}
    >
      <button
        onClick={handleClick}
        onContextMenu={onContextMenu}
        onKeyDown={handleButtonKeyDown}
        title={title}
        data-selected={isSelected && !grouped ? 'true' : undefined}
        className={cn(
          'sidebar-item group',
          groupSelected
            ? 'text-text-primary'
            : isSelected
              ? grouped
                ? 'text-text-primary'
                : ''
              : groupColorHex
                ? 'text-text-secondary'
                : ''
        )}
        style={
          tintBackground !== undefined || itemOpacity !== undefined
            ? { backgroundColor: tintBackground, opacity: itemOpacity }
            : undefined
        }
        onMouseEnter={(e) => {
          if (groupColorHex && !isSelected) {
            e.currentTarget.style.backgroundColor = `${groupColorHex}18`
          }
        }}
        onMouseLeave={(e) => {
          if (groupColorHex && !isSelected) {
            e.currentTarget.style.backgroundColor = ''
          }
        }}
      >
        {/* Icon */}
        {icon}

        {/* Name — double-click to rename */}
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleInputKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 bg-transparent text-control font-medium text-text-primary outline-none border-none"
          />
        ) : (
          <span
            data-testid="session-tab-name"
            className="flex-1 min-w-0 text-control font-medium truncate"
            onDoubleClick={handleDoubleClick}
          >
            {name}
          </span>
        )}

        {/* Extra content (e.g. location badge) */}
        {extraContent}

        {/* Close button — visible on hover */}
        {!editing && onDelete && !isDragging && (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="btn-icon btn-icon-xs flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <XMarkIcon className="w-3.5 h-3.5" />
          </span>
        )}
      </button>
    </div>
  )
}
