import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AnimatePresence } from 'framer-motion'
import { ModalScrim, ModalPositioner } from '@clave/ui/components'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'

interface AddMarketplaceDialogProps {
  isOpen: boolean
  onAdd: (source: string) => void
  onCancel: () => void
  busy?: boolean
}

/**
 * Prompt for a marketplace source (owner/repo, git URL, or local path) and
 * hand it back to the caller. Adding a marketplace fetches and trusts remote
 * code, so the dialog says so plainly before the user commits.
 */
export function AddMarketplaceDialog({ isOpen, onAdd, onCancel, busy }: AddMarketplaceDialogProps) {
  const [source, setSource] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setSource('')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen])

  const trimmed = source.trim()
  const canAdd = trimmed.length > 0 && !trimmed.startsWith('-') && !/\s/.test(trimmed) && !busy

  const submit = () => {
    if (canAdd) onAdd(trimmed)
  }

  return (
    <DialogPrimitive.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
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
              <ModalPositioner className="w-[360px]">
                <div className="modal-card">
                  <div className="px-4 pt-4 pb-3">
                    <DialogPrimitive.Title className="text-[13px] font-semibold text-text-primary">
                      Add marketplace
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Description className="mt-1 text-xs text-text-secondary">
                      Enter a GitHub repo, git URL, or local path.
                    </DialogPrimitive.Description>

                    <input
                      ref={inputRef}
                      type="text"
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          submit()
                        }
                      }}
                      placeholder="e.g. owner/repo"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      disabled={busy}
                      className="mt-3 w-full h-8 px-3 rounded-lg bg-surface-100 border border-border-subtle text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-accent transition-colors font-mono"
                    />

                    <div className="mt-3 flex items-start gap-2 px-2.5 py-2 rounded-lg bg-amber-500/8 border border-amber-500/20">
                      <ExclamationTriangleIcon className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-text-secondary leading-relaxed">
                        Adding a marketplace downloads and trusts code from the source. Only add
                        marketplaces you trust.
                      </p>
                    </div>
                  </div>
                  <div className="border-t border-border-subtle flex">
                    <button
                      type="button"
                      onClick={onCancel}
                      disabled={busy}
                      className="btn-dialog text-text-secondary hover:text-text-primary border-r border-border-subtle disabled:opacity-40"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={submit}
                      disabled={!canAdd}
                      className="btn-dialog text-accent hover:brightness-110 outline-none disabled:opacity-40"
                    >
                      {busy ? 'Adding…' : 'Add'}
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
