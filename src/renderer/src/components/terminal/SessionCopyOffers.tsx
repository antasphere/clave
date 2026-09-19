import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ClipboardDocumentIcon,
  CheckIcon,
  XMarkIcon,
  LockClosedIcon
} from '@heroicons/react/24/outline'
import { Popover, PopoverTrigger, PopoverContent } from '@clave/ui/components'
import { useCopyOfferStore } from '../../store/copy-offer-store'
import { cn } from '@clave/ui/components'
import type { CopyOfferView } from '../../../../preload/index.d'

/**
 * Session-header entry point for agent-offered copyable values (the outbound
 * mirror of the toolbar secret popover). Renders nothing until the session's
 * agent has offered at least one value; then a copy button appears next to the
 * save-discussion/plan actions. The popover lists every offered value with a
 * preview — one click asks main to put the exact stored bytes on the
 * clipboard, formatting intact.
 */
export function SessionCopyOffers({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  // Select the stable array and filter in a memo — a filtering selector would
  // return a fresh reference every snapshot and re-render forever.
  const allOffers = useCopyOfferStore((s) => s.offers)
  const offers = useMemo(
    () => allOffers.filter((o) => o.callerSessionId === sessionId),
    [allOffers, sessionId]
  )
  const dismissSession = useCopyOfferStore((s) => s.dismissSession)
  const [open, setOpen] = useState(false)

  if (offers.length === 0) return null

  const uncopiedCount = offers.filter((o) => !o.copiedAt).length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="btn-icon btn-icon-sm hover:bg-surface-300 relative"
          title={
            uncopiedCount > 0
              ? `${uncopiedCount} value(s) to copy`
              : 'Copyable values from this session'
          }
          style={uncopiedCount > 0 ? { color: 'var(--color-status-waiting)' } : undefined}
        >
          <ClipboardDocumentIcon className="w-3.5 h-3.5" />
          {uncopiedCount > 0 && (
            <span
              className="badge absolute -top-1 -right-1 text-white"
              style={{
                backgroundColor: 'var(--color-status-waiting)',
                animation: 'pulse-dot 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite'
              }}
            >
              {uncopiedCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        animated
        open={open}
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-[380px]"
        // The terminal grabs focus whenever output arrives; without this the
        // popover closes mid-read every time the agent prints something.
        // Click-outside and Escape still close it.
        onFocusOutside={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle">
          <ClipboardDocumentIcon className="w-3.5 h-3.5 text-text-tertiary" />
          <span className="text-xs text-text-secondary flex-1">Copyable values</span>
          <button
            onClick={() => void dismissSession(sessionId)}
            className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          >
            Clear all
          </button>
          <button onClick={() => setOpen(false)} className="btn-icon btn-icon-xs">
            <XMarkIcon className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="max-h-[400px] overflow-y-auto">
          {offers.map((offer, i) => (
            <div key={offer.id} className={cn(i > 0 && 'border-t border-border-subtle')}>
              <CopyOfferCard offer={offer} />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function CopyOfferCard({ offer }: { offer: CopyOfferView }): React.JSX.Element {
  const copy = useCopyOfferStore((s) => s.copy)
  const dismiss = useCopyOfferStore((s) => s.dismiss)
  const [justCopied, setJustCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [])

  const handleCopy = async (): Promise<void> => {
    await copy(offer.id)
    setJustCopied(true)
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setJustCopied(false), 1500)
  }

  const meta = [offer.lineCount > 1 ? `${offer.lineCount} lines` : null, `${offer.charCount} chars`]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <p className="text-xs text-text-primary flex-1 leading-snug">
          {offer.label}
          {offer.copiedAt && !justCopied && (
            <CheckIcon className="w-3 h-3 inline-block ml-1 text-text-tertiary align-[-1px]" />
          )}
        </p>
        <button
          onClick={() => void dismiss(offer.id)}
          className="btn-icon btn-icon-xs shrink-0"
          title="Dismiss"
        >
          <XMarkIcon className="w-3 h-3" />
        </button>
      </div>

      <div
        className="rounded p-2 max-h-28 overflow-auto select-text font-mono text-[11px] text-text-secondary"
        style={{ backgroundColor: 'var(--surface-0)' }}
      >
        {offer.sensitive ? (
          <span className="flex items-center gap-1.5 text-text-tertiary">
            <LockClosedIcon className="w-3 h-3" />
            hidden value — copy to use it
          </span>
        ) : (
          <span className="whitespace-pre-wrap break-all">
            {offer.preview}
            {offer.truncated && <span className="text-text-tertiary">…</span>}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] text-text-tertiary flex-1">{meta}</span>
        <button
          onClick={() => void handleCopy()}
          className={cn('btn-secondary flex items-center gap-1', justCopied && 'text-status-ready')}
        >
          {justCopied ? (
            <>
              <CheckIcon className="w-3 h-3" />
              Copied
            </>
          ) : (
            <>
              <ClipboardDocumentIcon className="w-3 h-3" />
              Copy
            </>
          )}
        </button>
      </div>
    </div>
  )
}
