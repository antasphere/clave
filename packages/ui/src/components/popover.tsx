import * as React from 'react'
import * as PopoverPrimitive from '../primitives/popover'
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
    /** `rise` drops the scale and keeps the fade and the 4px rise: for a
     *  popover that holds a web view, which is composited out of process and
     *  does not follow a scale on its parent, so it jumped against the frame
     *  while the frame grew. Default `pop`. */
    motion?: 'pop' | 'rise'
    /** `false` drops the surface (`.menu-surface`, its padding): the content
     *  draws its own, for a popover whose surface animates inside a frame
     *  the positioning engine sizes once (the Routines popover). Default
     *  `true`. Animated mode only. */
    surface?: boolean
  }
>(
  (
    {
      className,
      align = 'start',
      sideOffset = 6,
      animated,
      open,
      motion: kind = 'pop',
      surface = true,
      children,
      ...props
    },
    ref
  ) => {
    const from = kind === 'rise' ? { opacity: 0, y: -4 } : { opacity: 0, scale: 0.96, y: -4 }
    const to = kind === 'rise' ? { opacity: 1, y: 0 } : { opacity: 1, scale: 1, y: 0 }
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
                  initial={from}
                  animate={to}
                  exit={from}
                  transition={popoverTransition}
                  className={cn(surface ? 'menu-surface w-auto p-1' : 'w-auto', className)}
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
          className={cn('menu-surface menu-pop z-50 w-auto outline-none p-1', className)}
          {...props}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    )
  }
)
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
