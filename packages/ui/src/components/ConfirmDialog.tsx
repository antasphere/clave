import { useEffect, useRef } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AnimatePresence } from 'framer-motion'
import { ModalScrim, ModalPositioner } from './dialog'

interface ConfirmDialogProps {
  isOpen: boolean
  onConfirm: () => void
  onCancel: () => void
  title: string
  message: string
  confirmLabel?: string
}

export function ConfirmDialog({
  isOpen,
  onConfirm,
  onCancel,
  title,
  message,
  confirmLabel = 'Delete'
}: ConfirmDialogProps): React.JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => confirmRef.current?.focus(), 50)
    }
  }, [isOpen])

  return (
    <DialogPrimitive.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AnimatePresence>
        {isOpen && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild>
              <ModalScrim />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              asChild
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <ModalPositioner className="w-[280px]">
                <div className="modal-card">
                  <div className="px-4 pt-4 pb-3 text-center">
                    <DialogPrimitive.Title className="text-[13px] font-semibold text-text-primary">
                      {title}
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Description className="mt-1.5 text-xs text-text-secondary leading-relaxed">
                      {message}
                    </DialogPrimitive.Description>
                  </div>
                  <div className="border-t border-border-subtle flex">
                    <button
                      type="button"
                      onClick={onCancel}
                      className="btn-dialog text-text-secondary hover:text-text-primary border-r border-border-subtle"
                    >
                      Cancel
                    </button>
                    <button
                      ref={confirmRef}
                      type="button"
                      onClick={onConfirm}
                      className="btn-dialog text-red-400 hover:text-red-300 outline-none"
                    >
                      {confirmLabel}
                    </button>
                  </div>
                </div>
              </ModalPositioner>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}
