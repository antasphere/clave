import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { motion } from 'framer-motion'
import { cn } from '../lib/utils'

/* Shared motion for the framer-driven dialogs (Confirm, GroupCommand, Export,
   RestorePrompt). One place for the scrim and the card entrance, so every
   modal opens and closes with the same weight. */
const modalTransition = {
  duration: 0.16,
  ease: [0.2, 0, 0, 1] as const
}

/** The animated scrim — mount inside `<DialogPrimitive.Overlay asChild>`. */
export const ModalScrim = React.forwardRef<HTMLDivElement>((props, ref) => (
  <motion.div
    ref={ref}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.14 }}
    className="modal-scrim z-50"
    {...props}
  />
))
ModalScrim.displayName = 'ModalScrim'

/** The animated, centered positioner — mount inside
 *  `<DialogPrimitive.Content asChild>`; put a `.modal-card` div inside. */
export const ModalPositioner = React.forwardRef<
  HTMLDivElement,
  Omit<
    React.HTMLAttributes<HTMLDivElement>,
    'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart'
  >
>(({ className, children, ...props }, ref) => (
  <motion.div
    ref={ref}
    initial={{ opacity: 0, scale: 0.97 }}
    animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.98 }}
    transition={modalTransition}
    className={cn('fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2', className)}
    {...props}
  >
    {children}
  </motion.div>
))
ModalPositioner.displayName = 'ModalPositioner'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close
const DialogPortal = DialogPrimitive.Portal

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay ref={ref} className={cn('modal-scrim z-50', className)} {...props} />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
        'modal-card modal-pop',
        className
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-[13px] font-semibold text-text-primary', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-xs text-text-secondary leading-relaxed', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription
}
