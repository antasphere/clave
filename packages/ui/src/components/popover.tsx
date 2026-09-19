import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '../lib/utils'

const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger
const PopoverAnchor = PopoverPrimitive.Anchor

const popoverTransition = {
  duration: 0.14,
  ease: [0.2, 0, 0, 1] as const
}

/**
 * PopoverContent with two animation modes:
 *
 * 1. **Default (CSS):** `.menu-surface` look + `.menu-pop` data-state
 *    animations from the design system.
 * 2. **Framer Motion:** Pass `animated` + `open` props for enter/exit
 *    animations driven by Framer Motion (matching the app's panel pattern).
 *    Uses `forceMount` internally so AnimatePresence controls the lifecycle.
 */
const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    /** Enable Framer Motion enter/exit animation. Requires `open` prop. */
    animated?: boolean
    /** Current open state — required when `animated` is true. */
    open?: boolean
  }
>(({ className, align = 'start', sideOffset = 6, animated, open, children, ...props }, ref) => {
  if (animated) {
    return (
      <AnimatePresence>
        {open && (
          <PopoverPrimitive.Portal forceMount>
            <PopoverPrimitive.Content
              ref={ref}
              forceMount
              align={align}
              sideOffset={sideOffset}
              className="z-50 outline-none"
              {...props}
              asChild
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -4 }}
                transition={popoverTransition}
                className={cn('menu-surface w-auto', className)}
              >
                {children}
              </motion.div>
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        )}
      </AnimatePresence>
    )
  }

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn('menu-surface menu-pop z-50 w-auto outline-none', className)}
        {...props}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
})
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
