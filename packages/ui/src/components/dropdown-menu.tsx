import * as React from 'react'
import * as DropdownMenuPrimitive from '../primitives/dropdown-menu'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '../lib/utils'
import { AIM_REST_MS, aimVerdict, recordAim, type AimPoint } from '../lib/submenu-aim'

const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
const DropdownMenuGroup = DropdownMenuPrimitive.Group

/**
 * One menu surface as the aim rule sees it (`lib/submenu-aim.ts`,
 * PRDCT-4659): which of its submenus is open, the element of each open one,
 * and the pointer's last positions over the surface's own rows. The menu and
 * each submenu hold one for their rows, and a submenu opens through the
 * surface its trigger sits on, so a row can take over from an open sibling
 * where Radix's pointer grace alone would keep the sibling.
 */
interface MenuSurface {
  openId: string | null
  setOpenId: React.Dispatch<React.SetStateAction<string | null>>
  submenus: Map<string, HTMLElement>
  trail: AimPoint[]
}

const MenuSurfaceContext = React.createContext<MenuSurface | null>(null)

/** The submenu a trigger opens, and the surface the trigger sits on. */
interface SubmenuRow {
  id: string
  surface: MenuSurface
}

const SubmenuRowContext = React.createContext<SubmenuRow | null>(null)

function useMenuSurface(): MenuSurface {
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [submenus] = React.useState(() => new Map<string, HTMLElement>())
  const [trail] = React.useState<AimPoint[]>(() => [])
  return React.useMemo(() => ({ openId, setOpenId, submenus, trail }), [openId, submenus, trail])
}

/** The pointer over a surface's own rows. React carries a portalled
 *  submenu's events up to its parent surface too, so a move counts only when
 *  its target sits inside the surface, as Radix reads it. */
function recordPointer(surface: MenuSurface, event: React.PointerEvent<HTMLElement>): void {
  if (event.pointerType !== 'mouse') return
  if (!event.currentTarget.contains(event.target as Node)) return
  recordAim(surface.trail, { x: event.clientX, y: event.clientY })
}

/**
 * A row's half of the aim rule. Moved onto while a sibling's submenu is open,
 * the row takes over: it takes the focus, which is how Radix closes the
 * sibling, and opens its own submenu when it has one (`id`). Unless the
 * pointer is heading into the open submenu: then the row takes over only if
 * the pointer is still on it `AIM_REST_MS` after it arrived. With no sibling
 * open, Radix's own rules stand.
 */
function useAimTakeover(
  surface: MenuSurface | null,
  id: string | null,
  disabled: boolean | undefined
): { onMove: (event: React.PointerEvent<HTMLElement>) => void; onLeave: () => void } {
  const rest = React.useRef<number | null>(null)
  const settle = React.useCallback((): void => {
    if (rest.current !== null) window.clearTimeout(rest.current)
    rest.current = null
  }, [])
  React.useEffect(() => settle, [settle])
  const onMove = (event: React.PointerEvent<HTMLElement>): void => {
    if (!surface || disabled || event.pointerType !== 'mouse') return
    const open = surface.openId
    if (open === null || open === id) return
    const row = event.currentTarget
    const take = (): void => {
      settle()
      row.focus({ preventScroll: true })
      surface.setOpenId(id)
    }
    const submenu = surface.submenus.get(open)
    const verdict = aimVerdict(
      surface.trail,
      { x: event.clientX, y: event.clientY },
      submenu
        ? {
            rect: submenu.getBoundingClientRect(),
            side: submenu.dataset.side === 'left' ? 'left' : 'right'
          }
        : null
    )
    if (verdict === 'take') take()
    else if (rest.current === null) rest.current = window.setTimeout(take, AIM_REST_MS)
  }
  return { onMove, onLeave: settle }
}

const dropdownTransition = {
  duration: 0.14,
  ease: [0.2, 0, 0, 1] as const
}

const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
    animated?: boolean
    open?: boolean
  }
>(({ className, sideOffset = 4, animated, open, children, onPointerMove, ...props }, ref) => {
  const surface = useMenuSurface()
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    onPointerMove?.(event)
    recordPointer(surface, event)
  }
  const rows = <MenuSurfaceContext.Provider value={surface}>{children}</MenuSurfaceContext.Provider>

  if (animated) {
    return (
      <AnimatePresence>
        {open && (
          <DropdownMenuPrimitive.Portal forceMount>
            <DropdownMenuPrimitive.Content
              ref={ref}
              forceMount
              sideOffset={sideOffset}
              className="z-50 outline-none"
              onPointerMove={handlePointerMove}
              {...props}
              asChild
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -4 }}
                transition={dropdownTransition}
                className={cn('menu-surface min-w-[220px] p-1', className)}
              >
                {rows}
              </motion.div>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        )}
      </AnimatePresence>
    )
  }

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn('menu-surface menu-pop z-50 min-w-[220px] p-1', className)}
        onPointerMove={handlePointerMove}
        {...props}
      >
        {rows}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  )
})
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { danger?: boolean }
>(({ className, danger, onPointerMove, onPointerLeave, ...props }, ref) => {
  const aim = useAimTakeover(React.useContext(MenuSurfaceContext), null, props.disabled)
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn('menu-item', danger && 'menu-item--danger', className)}
      onPointerMove={(event) => {
        onPointerMove?.(event)
        if (!event.defaultPrevented) aim.onMove(event)
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event)
        aim.onLeave()
      }}
      {...props}
    />
  )
})
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

/** A row that turns something on or off (`checked`, `onCheckedChange`), read
 *  by assistive technology as a checkbox. It closes the menu like any row
 *  unless its `onSelect` prevents that; the caller draws the mark. */
const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, onPointerMove, onPointerLeave, ...props }, ref) => {
  const aim = useAimTakeover(React.useContext(MenuSurfaceContext), null, props.disabled)
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn('menu-item', className)}
      onPointerMove={(event) => {
        onPointerMove?.(event)
        if (!event.defaultPrevented) aim.onMove(event)
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event)
        aim.onLeave()
      }}
      {...props}
    />
  )
})
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName

const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label ref={ref} className={cn('menu-label', className)} {...props} />
))
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName

const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} className={cn('menu-sep', className)} {...props} />
))
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

const DropdownMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element => (
  <span className={cn('ml-auto text-[11px] text-text-tertiary', className)} {...props} />
)

/** A submenu. Inside one of these menus, and unless the caller drives it with
 *  `open`, it opens through the surface its trigger sits on (`MenuSurface`),
 *  so a sibling row the pointer moves onto can take over from it. */
function DropdownMenuSub({
  open,
  onOpenChange,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Sub>): React.JSX.Element {
  const surface = React.useContext(MenuSurfaceContext)
  const id = React.useId()
  const setOpenId = surface?.setOpenId
  const handleOpenChange = React.useCallback(
    (next: boolean): void => {
      setOpenId?.((current) => (next ? id : current === id ? null : current))
      onOpenChange?.(next)
    },
    [id, setOpenId, onOpenChange]
  )
  const managed = surface !== null && open === undefined
  const row = React.useMemo(
    () => (managed && surface ? { id, surface } : null),
    [managed, id, surface]
  )
  return (
    <SubmenuRowContext.Provider value={row}>
      {managed && surface ? (
        <DropdownMenuPrimitive.Sub
          {...props}
          open={surface.openId === id}
          onOpenChange={handleOpenChange}
        >
          {children}
        </DropdownMenuPrimitive.Sub>
      ) : (
        <DropdownMenuPrimitive.Sub {...props} open={open} onOpenChange={onOpenChange}>
          {children}
        </DropdownMenuPrimitive.Sub>
      )}
    </SubmenuRowContext.Provider>
  )
}

const DropdownMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, onPointerMove, onPointerLeave, ...props }, ref) => {
  const row = React.useContext(SubmenuRowContext)
  const aim = useAimTakeover(row?.surface ?? null, row?.id ?? null, props.disabled)
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={cn('menu-item', className)}
      onPointerMove={(event) => {
        onPointerMove?.(event)
        if (!event.defaultPrevented) aim.onMove(event)
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event)
        aim.onLeave()
      }}
      {...props}
    />
  )
})
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName

/** A submenu is anchored to its trigger ROW, which sits inside the parent
 *  menu's 4px padding and 1px border. At Radix's default offset of 0 the
 *  submenu therefore lay over the parent's edge, touching the row. It opens
 *  beside the parent menu instead, with a small gap: 5px to clear the parent's
 *  padding and border, then 6px of air. Radix's pointer grace area spans the
 *  gap, so the pointer can cross it without the submenu closing; a sibling
 *  row the pointer moves onto still takes over (`useAimTakeover`). The -5
 *  alignment lines the submenu's first row up with the trigger row. */
export const SUBMENU_SIDE_OFFSET = 11
export const SUBMENU_ALIGN_OFFSET = -5

const DropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(
  (
    {
      className,
      sideOffset = SUBMENU_SIDE_OFFSET,
      alignOffset = SUBMENU_ALIGN_OFFSET,
      onPointerMove,
      children,
      ...props
    },
    ref
  ) => {
    const row = React.useContext(SubmenuRowContext)
    const surface = useMenuSurface()
    // The parent surface reads this element's box to tell whether the pointer
    // is heading into it.
    const setRef = React.useCallback(
      (node: React.ComponentRef<typeof DropdownMenuPrimitive.SubContent> | null): void => {
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
        if (!row) return
        if (node) row.surface.submenus.set(row.id, node)
        else row.surface.submenus.delete(row.id)
      },
      [ref, row]
    )
    return (
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.SubContent
          ref={setRef}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          className={cn('menu-surface menu-pop z-50 min-w-[200px] p-1', className)}
          onPointerMove={(event) => {
            onPointerMove?.(event)
            recordPointer(surface, event)
          }}
          {...props}
        >
          <MenuSurfaceContext.Provider value={surface}>{children}</MenuSurfaceContext.Provider>
        </DropdownMenuPrimitive.SubContent>
      </DropdownMenuPrimitive.Portal>
    )
  }
)
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
}
