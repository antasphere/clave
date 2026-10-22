import { isRemoteKey } from '../../lib/fleet-identity'
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline'
import { useSessionStore } from '../../store/session-store'
import { messageNeedle, scrollXtermToText } from '../../lib/terminal-scroll'
import type { ConversationTurn } from '../../../../preload/index.d'

/**
 * The message trail: a floating box over a tab's terminal that answers "what
 * was this conversation about" without scrolling — the human messages of the
 * live transcript, one at a time (chevrons walk them, newest by default),
 * each with the first line of the agent's final answer under it, expandable
 * to a five-turn window. Clicking a message scrolls the terminal to it: tmux
 * tabs are driven in main (copy-mode text search, which also highlights),
 * plain tabs by scanning xterm's own buffer.
 *
 * Data is the transcript, read incrementally in main (`history:conversation`).
 * Refresh rides the agent-state words — a prompt submitted or an answer
 * landed both move the state — with a slow poll as the net for everything
 * hooks don't carry.
 */

const WINDOW = 5

function relativeTime(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (!Number.isFinite(m) || m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function MessageTrail({ sessionId }: { sessionId: string }): ReactElement | null {
  const enabled = useSessionStore((s) => s.messageTrailEnabled)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const isSelected = useSessionStore((s) => s.selectedSessionIds.includes(sessionId))
  const [turns, setTurns] = useState<ConversationTurn[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [miss, setMiss] = useState(false)
  /** Which way the last navigation went, for the slide direction. */
  const [dir, setDir] = useState(1)

  const cwd = session?.cwd
  const claudeSessionId = session?.claudeSessionId ?? session?.piSessionId ?? null
  const provider = session?.piMode ? ('pi' as const) : ('claude' as const)
  const agentState = session?.agentState

  // A /clear rotates the transcript id: the trail follows the new
  // conversation. Render-phase reset, so the stale turns never paint.
  const [convKey, setConvKey] = useState(claudeSessionId)
  if (convKey !== claudeSessionId) {
    setConvKey(claudeSessionId)
    setCursor(null)
    setExpanded(false)
    setTurns([])
  }

  const refresh = useCallback((): void => {
    if (!cwd || !claudeSessionId || isRemoteKey(sessionId)) return
    window.electronAPI
      .historyConversation(cwd, claudeSessionId, provider)
      .then((res) => setTurns(res.turns))
      // Best-effort: the trail just keeps what it last had.
      .catch(() => {})
  }, [cwd, claudeSessionId, provider, sessionId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // The agent-state words are the "something happened" signal (a submitted
  // prompt and a landed answer both move the state). The trailing re-read
  // covers the transcript being written moments after the hook fires.
  useEffect(() => {
    if (!agentState) return
    refresh()
    const t = setTimeout(refresh, 1500)
    return () => clearTimeout(t)
  }, [agentState, refresh])

  // The net under the hooks, only while the tab is actually on screen. The
  // read is stat-gated in main, so a quiet transcript costs one stat.
  useEffect(() => {
    if (!enabled || !isSelected || !claudeSessionId) return
    const iv = setInterval(refresh, 5000)
    return () => clearInterval(iv)
  }, [enabled, isSelected, claudeSessionId, refresh])

  const last = turns.length - 1
  const eff = cursor === null ? last : Math.min(cursor, last)

  const goTo = useCallback(
    (i: number): void => {
      setDir(i > eff ? 1 : -1)
      setCursor(i >= last ? null : Math.max(0, i))
    },
    [eff, last]
  )

  const jump = useCallback(
    async (i: number): Promise<void> => {
      const turn = turns[i]
      if (!turn) return
      const needle = messageNeedle(turn.userText)
      if (!needle) return
      // A repeated prompt ("continue") is addressed as the k-th occurrence
      // counting from the newest — the contract both scroll paths share.
      let fromBottom = 1
      for (let k = i + 1; k < turns.length; k++) {
        if (messageNeedle(turns[k].userText) === needle) fromBottom++
      }
      const res = await window.electronAPI.scrollSessionToText(sessionId, needle, fromBottom)
      if (!res.tmux && !scrollXtermToText(sessionId, needle, fromBottom)) {
        setMiss(true)
        setTimeout(() => setMiss(false), 350)
      }
    },
    [turns, sessionId]
  )

  if (!enabled || !session || !claudeSessionId || turns.length === 0) return null

  const start = Math.max(0, Math.min(eff - Math.floor(WINDOW / 2), turns.length - WINDOW))
  const windowTurns = turns.slice(start, start + WINDOW)

  return (
    <div
      className="message-trail"
      data-view={expanded ? 'list' : 'line'}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <motion.div
        layout
        initial={false}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        className={`menu-surface message-trail-surface ${miss ? 'message-trail--miss' : ''}`}
      >
        {!expanded ? (
          // Everything centers on the box's axis — the text, the pager, the
          // counter — except the two action buttons, which hold the top.
          <div className="flex items-center gap-0.5 px-0.5 py-0.5">
            <div className="flex flex-col flex-shrink-0">
              <button
                className="panel-icon-btn"
                onClick={() => goTo(eff - 1)}
                disabled={eff <= 0}
                aria-label="Previous message"
                title="Previous message"
              >
                <ChevronUpIcon className="w-4 h-4" />
              </button>
              <button
                className="panel-icon-btn"
                onClick={() => goTo(eff + 1)}
                disabled={eff >= last}
                aria-label="Next message"
                title="Next message"
              >
                <ChevronDownIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="relative flex-1 min-w-0 overflow-hidden mr-1.5">
              {/* The panel toggle: a small chevron floating over the title,
                  revealed by hovering the box. It opens the surrounding-turns
                  panel, where the current message also reads unclamped. */}
              <button
                className="message-trail-peek"
                onClick={() => setExpanded(true)}
                aria-label="Expand messages"
                title="Show the conversation"
              >
                <ChevronDownIcon className="w-3 h-3" />
              </button>
              <AnimatePresence mode="popLayout" initial={false} custom={dir}>
                <motion.button
                  key={`${claudeSessionId}:${eff}`}
                  custom={dir}
                  variants={{
                    enter: (d: number) => ({ y: d * 10, opacity: 0 }),
                    center: { y: 0, opacity: 1 },
                    exit: (d: number) => ({ y: d * -10, opacity: 0 })
                  }}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.14, ease: 'easeOut' }}
                  className="message-trail-line"
                  onClick={() => void jump(eff)}
                  title="Scroll to this message"
                >
                  <div className="message-trail-text">{turns[eff].userText}</div>
                  {turns[eff].replyHead && (
                    <div className="message-trail-reply">{turns[eff].replyHead}</div>
                  )}
                </motion.button>
              </AnimatePresence>
            </div>
            <span className="message-trail-count flex-shrink-0">
              {eff + 1}/{turns.length}
            </span>
          </div>
        ) : (
          <div className="py-0.5">
            <div className="flex items-center justify-between pl-2 pr-0.5 pb-0.5">
              <span className="message-trail-count message-trail-count--compact">
                {eff + 1}/{turns.length}
              </span>
              <button
                className="panel-icon-btn"
                onClick={() => setExpanded(false)}
                aria-label="Collapse messages"
                title="Collapse"
              >
                <ChevronUpIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="px-1">
              {windowTurns.map((turn, w) => {
                const i = start + w
                return (
                  <button
                    key={`${claudeSessionId}:${i}`}
                    className="message-trail-row"
                    data-selected={i === eff || undefined}
                    onClick={() => {
                      goTo(i)
                      void jump(i)
                    }}
                    title="Scroll to this message"
                  >
                    <div className="flex items-baseline gap-2 min-w-0">
                      {/* The current turn reads WHOLE in the panel (capped,
                          scrolling inside) — this is where a big prompt is
                          read since the collapsed face keeps to one line. */}
                      <div
                        className={
                          i === eff
                            ? 'message-trail-text message-trail-text--full flex-1'
                            : 'message-trail-text flex-1'
                        }
                      >
                        {turn.userText}
                      </div>
                      {turn.ts && (
                        <span className="message-trail-time">{relativeTime(turn.ts)}</span>
                      )}
                    </div>
                    {turn.replyHead && <div className="message-trail-reply">{turn.replyHead}</div>}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  )
}
