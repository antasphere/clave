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
    /** Already in ButtonHTMLAttributes; named here because the trigger reads it
     *  and react/prop-types cannot see a prop declared in a library type. */
    disabled?: boolean
  }
>(({ tooltip, side = 'bottom', children, ...props }, ref) => (
  <Tooltip>
    {/* A disabled button emits no pointer events, so a tooltip hung on it
        never opens: the one moment a control needs to say why it is grey was
        the one moment it could not. Radix's answer is a wrapper that does
        receive the pointer; an inline-flex span keeps the button's box. */}
    {props.disabled ? (
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={-1}>
          <button ref={ref} {...props}>
            {children}
          </button>
        </span>
      </TooltipTrigger>
    ) : (
      <TooltipTrigger asChild>
        <button ref={ref} {...props}>
          {children}
        </button>
      </TooltipTrigger>
    )}
    <TooltipContent side={side}>{tooltip}</TooltipContent>
  </Tooltip>
))
IconButton.displayName = 'IconButton'

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, IconButton }
