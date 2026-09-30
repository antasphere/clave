import { useEffect, useRef } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AnimatePresence } from 'framer-motion'
import { ModalScrim, ModalPositioner } from '@clave/ui/components'
import { useRestorePromptStore } from '../../store/restore-prompt-store'

/** Launch restore prompt — shown when the previous run left sessions that can
 *  only come back via an actual relaunch (plain records, or tmux records whose
 *  server died with a reboot). Live tmux survivors never pass through here;
 *  they reattach silently because they were never disrupted. */
export function RestorePromptDialog(): React.JSX.Element | null {
  const pending = useRestorePromptStore((s) => s.pending)
  const resolver = useRestorePromptStore((s) => s.resolver)
  const restoreRef = useRef<HTMLButtonElement>(null)

  const isOpen = !!pending && !!resolver

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => restoreRef.current?.focus(), 50)
    }
  }, [isOpen])

  if (!isOpen) return null

  const agents = pending.filter(
    (r) => r.claudeMode || r.antigravityMode || r.codexMode || r.piMode || r.claudeAgentsMode
  ).length
  const terminals = pending.length - agents
  const parts: string[] = []
  if (agents > 0) parts.push(`${agents} agent session${agents === 1 ? '' : 's'}`)
  if (terminals > 0) parts.push(`${terminals} terminal${terminals === 1 ? '' : 's'}`)

  return (
    <DialogPrimitive.Root open={isOpen}>
      <AnimatePresence>
        <DialogPrimitive.Portal forceMount>
          <DialogPrimitive.Overlay asChild>
            <ModalScrim />
          </DialogPrimitive.Overlay>
          <DialogPrimitive.Content
            asChild
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onEscapeKeyDown={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <ModalPositioner className="w-[300px]">
              <div className="modal-card">
                <div className="px-4 pt-4 pb-3 text-center">
                  <DialogPrimitive.Title className="text-control font-semibold text-text-primary">
                    Restore previous session?
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="mt-1.5 text-xs text-text-secondary leading-relaxed">
                    {parts.join(' and ')} from last time can be relaunched — terminals reopen in
                    their folders, agents resume their conversations. Commands are not re-run.
                  </DialogPrimitive.Description>
                </div>
                <div className="border-t border-border-subtle flex">
                  <button
                    type="button"
                    onClick={() => resolver(false)}
                    className="btn-dialog text-text-secondary hover:text-text-primary border-r border-border-subtle"
                  >
                    Start fresh
                  </button>
                  <button
                    ref={restoreRef}
                    type="button"
                    onClick={() => resolver(true)}
                    className="btn-dialog text-action hover:brightness-110 outline-none"
                  >
                    Restore
                  </button>
                </div>
              </div>
            </ModalPositioner>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}
