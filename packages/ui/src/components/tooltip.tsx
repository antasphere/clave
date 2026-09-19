import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '../lib/utils'

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'tooltip-pop z-[9999] overflow-hidden rounded-lg bg-surface-300 px-2.5 py-1.5 text-[11px] leading-tight text-text-primary shadow-lg',
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

/** Button with a tooltip — eliminates the 6-line Tooltip/Trigger/Content boilerplate. */
const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    tooltip: React.ReactNode
    side?: 'top' | 'bottom' | 'left' | 'right'
  }
>(({ tooltip, side = 'bottom', children, ...props }, ref) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button ref={ref} {...props}>
        {children}
      </button>
    </TooltipTrigger>
    <TooltipContent side={side}>{tooltip}</TooltipContent>
  </Tooltip>
))
IconButton.displayName = 'IconButton'

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, IconButton }
