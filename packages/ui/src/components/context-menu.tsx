import * as React from 'react'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '../lib/utils'

const ContextMenuRoot = ContextMenuPrimitive.Root
const ContextMenuTrigger = ContextMenuPrimitive.Trigger

const contextMenuTransition = {
  duration: 0.14,
  ease: [0.2, 0, 0, 1] as const
}

const ContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content> & {
    animated?: boolean
    open?: boolean
  }
>(({ className, animated, open, children, ...props }, ref) => {
  if (animated) {
    return (
      <AnimatePresence>
        {open && (
          <ContextMenuPrimitive.Portal forceMount>
            <ContextMenuPrimitive.Content
              ref={ref}
              forceMount
              className="z-50 outline-none"
              {...props}
              asChild
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={contextMenuTransition}
                className={cn('menu-surface min-w-[160px] p-1', className)}
              >
                {children}
              </motion.div>
            </ContextMenuPrimitive.Content>
          </ContextMenuPrimitive.Portal>
        )}
      </AnimatePresence>
    )
  }

  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        ref={ref}
        className={cn('menu-surface menu-pop z-50 min-w-[160px] p-1', className)}
        {...props}
      >
        {children}
      </ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Portal>
  )
})
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

const ContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & { danger?: boolean }
>(({ className, danger, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn('menu-item justify-between', danger && 'menu-item--danger', className)}
    {...props}
  />
))
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

const ContextMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator ref={ref} className={cn('menu-sep', className)} {...props} />
))
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

export {
  ContextMenuRoot,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
}
