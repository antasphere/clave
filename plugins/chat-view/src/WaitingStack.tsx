import { useEffect, useState } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { Tooltip, TooltipContent, TooltipTrigger } from '@clave/ui/components'
import type { WaitingMessage } from '../../../src/shared/session-model'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import { gist } from './exchanges'
import { takesLine, type WaitingTakes } from './waiting'

/** How long a leaving row takes to fold away; the stylesheet's transition is
 *  twice the default duration, and this waits a little past it (WorkCards). */
const LEAVE_MS = 340

/**
 * The messages that wait for the agent (PRDCT-4566), docked directly above
 * the composer: one row per message, in the order written. A row is the
 * delivery card's face on one line — the sending tab's name when another tab
 * wrote it, the message's first line, the whole of it on hover or focus —
 * then when it goes, and a withdraw. The conversation holds only what the
 * agent has taken: a row folds shut as the agent takes its message, which is
 * then drawn in the transcript, after the answer before it.
 */
export function WaitingStack({
  messages,
  takes,
  agent,
  onWithdraw
}: {
  messages: WaitingMessage[]
  takes: WaitingTakes | null
  /** The agent's name, for when it takes a message. */
  agent: string
  onWithdraw: (id: string) => void
}): React.JSX.Element | null {
  const [leaving, setLeaving] = useState<WaitingMessage[]>([])
  const [previous, setPrevious] = useState(messages)
  // A row the list no longer holds is kept, marked leaving, for the fold.
  if (previous !== messages) {
    const ids = new Set(messages.map((m) => m.id))
    const gone = previous.filter((m) => !ids.has(m.id))
    setPrevious(messages)
    setLeaving((current) => [
      ...current.filter((m) => !ids.has(m.id)),
      ...gone.filter((m) => !current.some((c) => c.id === m.id))
    ])
  }
  useEffect(() => {
    if (!leaving.length) return
    const timer = window.setTimeout(() => setLeaving([]), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [leaving])
  if (!messages.length && !leaving.length) return null
  const rows = [
    ...messages.map((message) => ({ message, gone: false })),
    ...leaving.map((message) => ({ message, gone: true }))
  ]
  const when = takesLine(takes, agent)
  return (
    <section
      className="chat-waiting-stack"
      data-waiting-stack=""
      data-empty={messages.length ? undefined : 'true'}
      aria-label={`${messages.length} ${messages.length === 1 ? 'message' : 'messages'} waiting`}
    >
      <ol className="chat-waiting-list">
        {rows.map(({ message, gone }) => (
          <WaitingRow
            key={message.id}
            message={message}
            when={when}
            gone={gone}
            onWithdraw={onWithdraw}
          />
        ))}
      </ol>
    </section>
  )
}

function WaitingRow({
  message,
  when,
  gone,
  onWithdraw
}: {
  message: WaitingMessage
  when: string
  gone: boolean
  onWithdraw: (id: string) => void
}): React.JSX.Element {
  // Another tab's message is named as the delivery card names it, its words
  // without the bracketed header.
  const delivery = parseDelivery(message.text)
  const name = delivery ? (delivery.sender?.name ?? 'Another agent') : null
  const body = (delivery?.body ?? message.text).trim()
  const files = message.attachments ?? []
  const filesLine = files.length
    ? files.length === 1
      ? files[0].name
      : `${files.length} files`
    : ''
  return (
    <li
      className="chat-waiting-row"
      data-waiting-message={message.id}
      data-from={delivery ? 'tab' : undefined}
      data-leaving={gone || undefined}
    >
      <div className="chat-waiting-fold">
        <div className="chat-waiting-face">
          <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
              <span
                className="chat-waiting-text"
                tabIndex={gone ? -1 : 0}
                aria-label={`${name ? `From ${name}: ` : ''}${body || filesLine}`}
              >
                {name && <span className="chat-waiting-from">{name}</span>}
                <span className="chat-waiting-gist">{gist(body) || filesLine}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="chat-waiting-whole">
              {body || filesLine}
            </TooltipContent>
          </Tooltip>
          <span className="chat-waiting-when">{when}</span>
          <button
            type="button"
            className="chat-turn-copy chat-waiting-withdraw"
            data-waiting-withdraw=""
            aria-label="Withdraw"
            title="Withdraw"
            disabled={gone}
            onClick={() => onWithdraw(message.id)}
          >
            <XMarkIcon />
          </button>
        </div>
      </div>
    </li>
  )
}
