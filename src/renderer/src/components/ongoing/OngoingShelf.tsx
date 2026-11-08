import type React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ChatBubbleLeftEllipsisIcon } from '@heroicons/react/24/outline'
import { cn } from '@clave/ui/components'
import { useSessionStore } from '../../store/session-store'
import { attentionCount } from '../../lib/ongoing'
import { useOngoingRows } from './use-ongoing'
import './ongoing.css'

/**
 * The way to the ongoing conversations (PRDCT-4190): one slim card at the
 * sidebar's foot, above the announcements, and only while the workspace keeps
 * at least one. It says how many there are, and marks in the accent how many
 * ask for the person (a question waiting, a reply unread), so a long-lived
 * conversation that needs an answer is never out of sight. It reads as
 * pressed while the page is open or one of them is in the pane.
 */
export function OngoingShelf(): React.JSX.Element | null {
  const rows = useOngoingRows()
  const activeView = useSessionStore((s) => s.activeView)
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId)
  const reduceMotion = useReducedMotion()
  if (rows.length === 0) return null

  const attention = attentionCount(rows.map((r) => r.status))
  const viewingOne =
    activeView === 'terminals' && rows.some((r) => r.session && r.session.id === focusedSessionId)
  const pressed = activeView === 'ongoing' || viewingOne
  const count = rows.length
  const title = [
    `${count} ongoing conversation${count === 1 ? '' : 's'}`,
    attention > 0 ? `${attention} for you` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <motion.button
      type="button"
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
      className={cn('sidebar-panel ongoing-shelf', pressed && 'is-pressed')}
      data-ongoing-shelf
      data-ongoing-count={count}
      data-ongoing-attention={attention}
      aria-pressed={pressed}
      title={title}
      onClick={() => {
        const store = useSessionStore.getState()
        store.setActiveView(store.activeView === 'ongoing' ? 'terminals' : 'ongoing')
      }}
    >
      <ChatBubbleLeftEllipsisIcon className="ongoing-shelf-icon" />
      <span className="ongoing-shelf-label">Ongoing</span>
      {attention > 0 && (
        <span className="ongoing-shelf-attention" aria-label={`${attention} for you`}>
          <span className="ongoing-shelf-dot" />
          {attention}
        </span>
      )}
      <motion.span
        key={count}
        className="ongoing-shelf-count"
        initial={reduceMotion ? false : { scale: 1.35 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 520, damping: 22 }}
      >
        {count}
      </motion.span>
    </motion.button>
  )
}
