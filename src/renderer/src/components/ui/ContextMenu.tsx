import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { ChevronRightIcon } from '@heroicons/react/24/outline'
import { cn, SUBMENU_ALIGN_OFFSET, SUBMENU_SIDE_OFFSET } from '@clave/ui/components'

export interface ContextMenuItem {
  label: string
  /** Not called for an entry with a submenu: hovering it opens the submenu. */
  onClick: () => void
  shortcut?: string
  disabled?: boolean
  icon?: React.ReactNode
  danger?: boolean
  /** Opens beside the menu on hover rather than acting on a click. */
  submenu?: ContextMenuItem[]
  /** Replaces the icon-and-label body with a richer row. `label` still
   *  names the item (its key, its accessible text). */
  content?: React.ReactNode
  /** A card shown beside the menu while this entry is highlighted (hover or
   *  arrow keys): a look at what the entry leads to, never clickable. */
  preview?: React.ReactNode
}

interface ContextMenuProps {
  items: ContextMenuItem[]
  x: number
  y: number
  onClose: () => void
  header?: React.ReactNode
  /** Extra classes on the surface — a dialog above the default z-50 passes its own. */
  className?: string
}

// Estimated menu footprint, used to decide which side of the cursor to open on.
const ESTIMATED_MENU_WIDTH = 220
const ESTIMATED_MENU_HEIGHT = 280

export function ContextMenu({
  items,
  x,
  y,
  onClose,
  header,
  className
}: ContextMenuProps): React.JSX.Element {
  // Open leftward / upward when the cursor is too close to the viewport edge,
  // so the menu is never cropped off-screen.
  const align = x > window.innerWidth - ESTIMATED_MENU_WIDTH ? 'end' : 'start'
  const side = y > window.innerHeight - ESTIMATED_MENU_HEIGHT ? 'top' : 'bottom'

  return (
    <DropdownMenuPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DropdownMenuPrimitive.Trigger
        style={{
          position: 'fixed',
          left: x,
          top: y,
          width: 0,
          height: 0,
          padding: 0,
          margin: 0,
          border: 'none',
          opacity: 0,
          pointerEvents: 'none'
        }}
      />
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          side={side}
          align={align}
          sideOffset={0}
          alignOffset={0}
          avoidCollisions
          collisionPadding={8}
          className={cn('menu-surface menu-pop z-50 min-w-[180px] p-1', className)}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {header && (
            <>
              <div className="px-2 py-1.5">{header}</div>
              <DropdownMenuPrimitive.Separator className="menu-sep" />
            </>
          )}
          {items.map((item) => (
            <ContextMenuEntry
              key={item.label}
              item={item}
              onClose={onClose}
              className={className}
            />
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

function ContextMenuEntry({
  item,
  onClose,
  className,
  onHighlight
}: {
  item: ContextMenuItem
  onClose: () => void
  /** The root surface's extra classes, carried to a submenu's surface. */
  className?: string
  /** Told which row element is highlighted (null when none), for a preview. */
  onHighlight?: (row: HTMLElement | null) => void
}): React.JSX.Element {
  const body = item.content ?? (
    <span className="flex items-center gap-2">
      {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
      {item.label}
    </span>
  )
  if (item.submenu) {
    return (
      <DropdownMenuPrimitive.Sub>
        <DropdownMenuPrimitive.SubTrigger
          disabled={item.disabled}
          className="menu-item justify-between"
        >
          {body}
          <ChevronRightIcon className="w-3 h-3 ml-4 flex-shrink-0 text-text-tertiary" />
        </DropdownMenuPrimitive.SubTrigger>
        <DropdownMenuPrimitive.Portal>
          <SubmenuContent item={item} onClose={onClose} className={className} />
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Sub>
    )
  }
  return (
    <DropdownMenuPrimitive.Item
      disabled={item.disabled}
      onSelect={() => {
        item.onClick()
        onClose()
      }}
      onFocus={onHighlight ? (e) => onHighlight(e.currentTarget) : undefined}
      onBlur={onHighlight ? () => onHighlight(null) : undefined}
      aria-label={item.content ? item.label : undefined}
      className={cn('menu-item justify-between', item.danger && 'menu-item--danger')}
    >
      {body}
      {item.shortcut && <span className="ml-4 text-text-tertiary">{item.shortcut}</span>}
    </DropdownMenuPrimitive.Item>
  )
}

/** A submenu's surface, and the preview card of whichever of its entries is
 *  highlighted. Radix moves focus to the highlighted entry on hover and on
 *  the arrow keys alike, so focus is the one signal both follow. */
function SubmenuContent({
  item,
  onClose,
  className
}: {
  item: ContextMenuItem
  onClose: () => void
  className?: string
}): React.JSX.Element {
  const [active, setActive] = useState<{ label: string; row: HTMLElement } | null>(null)
  // A blur is followed at once by the next row's focus when the highlight
  // moves down the list: clear on the next frame so the card does not blink.
  const clearFrame = useRef<number | null>(null)
  const highlight = (label: string, row: HTMLElement | null): void => {
    if (clearFrame.current != null) cancelAnimationFrame(clearFrame.current)
    clearFrame.current = null
    if (row) {
      setActive({ label, row })
      return
    }
    clearFrame.current = requestAnimationFrame(() => {
      clearFrame.current = null
      setActive(null)
    })
  }
  const children = item.submenu ?? []
  const hasPreviews = children.some((child) => child.preview)
  const preview = active ? children.find((child) => child.label === active.label)?.preview : null
  return (
    <>
      <DropdownMenuPrimitive.SubContent
        sideOffset={SUBMENU_SIDE_OFFSET}
        alignOffset={SUBMENU_ALIGN_OFFSET}
        avoidCollisions
        collisionPadding={8}
        className={cn('menu-surface menu-pop z-50 min-w-[180px] p-1', className)}
      >
        {children.map((child) => (
          <ContextMenuEntry
            key={child.label}
            item={child}
            onClose={onClose}
            className={className}
            onHighlight={hasPreviews ? (row) => highlight(child.label, row) : undefined}
          />
        ))}
      </DropdownMenuPrimitive.SubContent>
      {preview && active && <MenuPreview row={active.row}>{preview}</MenuPreview>}
    </>
  )
}

const PREVIEW_GAP = 6
const VIEWPORT_PAD = 8

/** The preview card: beside the submenu on whichever side has room, level
 *  with the highlighted row, kept inside the window. It takes no pointer
 *  events, so the menu under the cursor stays the menu. */
function MenuPreview({
  row,
  children
}: {
  row: HTMLElement
  children: React.ReactNode
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    const menu = (row.closest('[role="menu"]') ?? row).getBoundingClientRect()
    const line = row.getBoundingClientRect()
    const { width, height } = card.getBoundingClientRect()
    const right = menu.right + PREVIEW_GAP
    const left =
      right + width <= window.innerWidth - VIEWPORT_PAD
        ? right
        : Math.max(VIEWPORT_PAD, menu.left - PREVIEW_GAP - width)
    const top = Math.min(
      Math.max(VIEWPORT_PAD, line.top - 4),
      window.innerHeight - VIEWPORT_PAD - height
    )
    setPosition({ left, top })
  }, [row])
  return createPortal(
    <div
      ref={cardRef}
      className="menu-surface menu-pop-mount menu-preview z-50"
      data-menu-preview
      aria-hidden
      style={
        position
          ? { left: position.left, top: position.top }
          : { left: -9999, top: 0, visibility: 'hidden' }
      }
    >
      {children}
    </div>,
    document.body
  )
}
