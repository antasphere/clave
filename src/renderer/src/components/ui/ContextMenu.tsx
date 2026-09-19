import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { cn } from '@clave/ui/components'

interface ContextMenuItem {
  label: string
  onClick: () => void
  shortcut?: string
  disabled?: boolean
  icon?: React.ReactNode
  danger?: boolean
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

export function ContextMenu({ items, x, y, onClose, header, className }: ContextMenuProps) {
  // Open leftward / upward when the cursor is too close to the viewport edge,
  // so the menu is never cropped off-screen.
  const align = x > window.innerWidth - ESTIMATED_MENU_WIDTH ? 'end' : 'start'
  const side = y > window.innerHeight - ESTIMATED_MENU_HEIGHT ? 'top' : 'bottom'

  return (
    <DropdownMenuPrimitive.Root open onOpenChange={(open) => { if (!open) onClose() }}>
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
            <DropdownMenuPrimitive.Item
              key={item.label}
              disabled={item.disabled}
              onSelect={() => {
                item.onClick()
                onClose()
              }}
              className={cn('menu-item justify-between', item.danger && 'menu-item--danger')}
            >
              <span className="flex items-center gap-2">
                {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
                {item.label}
              </span>
              {item.shortcut && <span className="ml-4 text-text-tertiary">{item.shortcut}</span>}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}
