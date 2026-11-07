import { useEffect, type ReactNode } from 'react'
import { ChatBubbleLeftRightIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useFeedbackStore } from '../../store/feedback-store'
import { TalkToUsDialog } from './TalkToUsDialog'

/**
 * The expanded invitation, in the sidebar's announcements slot.
 *
 * Panel material rather than the accent wash it used to wear: an accent-tinted
 * box is how this app says "something needs you", and an open invitation is not
 * that. It reads as one more card in the sidebar's chrome, with the ask itself
 * carrying the accent. Collapsed, it lives on as a single icon in the foot
 * panel (SidebarFooter) — see feedback-store for the shared state.
 */
export function FeedbackBanner(): ReactNode {
  const collapsed = useFeedbackStore((s) => s.collapsed)
  const collapse = useFeedbackStore((s) => s.collapse)
  const setDialogOpen = useFeedbackStore((s) => s.setDialogOpen)
  const load = useFeedbackStore((s) => s.load)

  useEffect(() => {
    load()
  }, [load])

  // null while loading, and nothing at all once collapsed.
  if (collapsed !== false) return null

  return (
    <div className="sidebar-panel px-2.5 py-2">
      <div className="relative z-[1] flex items-start justify-between gap-2">
        <span className="text-[12px] font-medium text-text-primary leading-tight">
          Help us make Clave better
        </span>
        <button onClick={collapse} aria-label="Dismiss" className="btn-icon btn-icon-xs -mr-1">
          <XMarkIcon className="w-3.5 h-3.5" />
        </button>
      </div>
      <p className="relative z-[1] text-[11px] text-text-tertiary mt-1 leading-relaxed">
        Clave has no accounts, so we don&apos;t know who uses it. We&apos;d love to talk to the
        people who do, so we can build the right things.
      </p>
      <button
        onClick={() => setDialogOpen(true)}
        className="relative z-[1] inline-flex items-center gap-1.5 text-[11px] font-medium text-accent hover:text-accent-hover mt-1.5"
      >
        <ChatBubbleLeftRightIcon className="w-3.5 h-3.5" />
        Talk to us
      </button>
    </div>
  )
}

/**
 * The dialog itself, mounted once by the sidebar. Both entry points — the card
 * above and the foot panel's icon — only flip `dialogOpen`, so there is never
 * more than one of these in the tree.
 */
export function FeedbackDialogHost(): ReactNode {
  const dialogOpen = useFeedbackStore((s) => s.dialogOpen)
  const setDialogOpen = useFeedbackStore((s) => s.setDialogOpen)
  const collapse = useFeedbackStore((s) => s.collapse)

  return <TalkToUsDialog open={dialogOpen} onOpenChange={setDialogOpen} onEngaged={collapse} />
}
