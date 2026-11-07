import { useState, type CSSProperties } from 'react'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import { useSessionStore } from '../../../src/renderer/src/store/session-store'
import { useDisclosure } from './disclosure'
import { gist, useExchange, type ExchangeSide } from './exchanges'
import { ExchangeDrawing } from './ExchangeDrawing'
import type { DeliveryEntry, DeliveryGroup } from './tools'

const senderName = (message: DeliveryEntry): string =>
  parseDelivery(message.text)?.sender?.name ?? 'Another agent'

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * The messages other tabs sent, as a timeline: one compact card per exchange,
 * one under the other, joined by a line down the left that starts at the
 * drawing at its head. A card's closed face is a line of text at the
 * transcript's own size — who wrote, the message's first line, whether this
 * session answered, when. It opens smoothly onto the exchange whole: what this
 * session had asked that tab, the message, and what it answered
 * (`indexExchanges`, by the tabs' ids). The timeline holds the messages ALONE:
 * what the agent says to the reader stays in the transcript beside it (the
 * deck of 5 November 2026 that captured the agent's replies hid a question
 * meant for the reader).
 */
export function DeliveryStack({
  group,
  id
}: {
  group: DeliveryGroup
  id: string
}): React.JSX.Element {
  const names = [...new Set(group.messages.map(senderName))]
  const count = group.messages.length
  return (
    <section
      className="chat-delivery-stack exchange-timeline"
      data-messages={count}
      aria-label={`${count} ${count === 1 ? 'message' : 'messages'} from ${names.join(', ')}`}
    >
      <header className="exchange-head">
        <ExchangeDrawing />
        <span className="exchange-title">
          <span className="exchange-eyebrow">From other tabs</span>
          <span className="exchange-names" title={names.join(', ')}>
            {names.join(', ')}
          </span>
        </span>
      </header>
      <ol className="exchange-list">
        {group.messages.map((message, index) => (
          <ExchangeCard key={index} message={message} id={`${id}-${index}`} order={index} />
        ))}
      </ol>
    </section>
  )
}

function ExchangeCard({
  message,
  id,
  order
}: {
  message: DeliveryEntry
  id: string
  /** Its place in the timeline, for the arrival's stagger. */
  order: number
}): React.JSX.Element {
  const disclosure = useDisclosure(id)
  const [built, setBuilt] = useState(disclosure.initial)
  const delivery = parseDelivery(message.text)
  const name = delivery?.sender?.name ?? 'Another agent'
  const body = (delivery?.body ?? message.text).trim()
  const { request, reply } = useExchange(message)
  return (
    <li
      className="exchange"
      data-replied={reply ? 'true' : undefined}
      style={{ '--exchange-i': Math.min(order, 6) } as CSSProperties}
    >
      <span className="exchange-node" aria-hidden="true" />
      <details
        className="exchange-card"
        open={disclosure.initial}
        onToggle={(event) => {
          if (disclosure.toggle(event)) setBuilt(true)
        }}
      >
        <summary className="exchange-summary">
          <span className="exchange-from">{name}</span>
          <span className="exchange-gist">{gist(body) || 'An empty message'}</span>
          {reply && <span className="exchange-status">answered</span>}
          <time className="exchange-time" dateTime={new Date(message.at).toISOString()}>
            {clock(message.at)}
          </time>
          <ChevronDownIcon className="exchange-chevron" aria-hidden="true" />
        </summary>
        <div className="exchange-body">
          {built && (
            <>
              {request && <ExchangePart who="You asked" side={request} />}
              <ExchangePart
                who={name}
                side={{ text: body, at: message.at }}
                from={delivery?.sender?.id}
                theirs
              />
              {reply ? (
                <ExchangePart who="You answered" side={reply} />
              ) : (
                <p className="exchange-note">No answer sent to {name} after this message.</p>
              )}
            </>
          )}
        </div>
      </details>
    </li>
  )
}

/** One piece of writing in an opened exchange: who wrote it and when, then the
 *  words, in the transcript's own type. The other tab's name opens it when it
 *  is in this window. */
function ExchangePart({
  who,
  side,
  from,
  theirs
}: {
  who: string
  side: ExchangeSide
  from?: string
  theirs?: boolean
}): React.JSX.Element {
  const here = useSessionStore((state) => !!from && state.sessions.some((s) => s.id === from))
  return (
    <div className="exchange-part" data-theirs={theirs || undefined}>
      <div className="exchange-part-head">
        {here && from ? (
          <button
            type="button"
            className="exchange-part-who"
            title={`Open the tab “${who}”`}
            onClick={() => useSessionStore.getState().selectSession(from, false)}
          >
            {who}
          </button>
        ) : (
          <span className="exchange-part-who">{who}</span>
        )}
        <span className="exchange-part-time">{clock(side.at)}</span>
      </div>
      <div className="exchange-part-text">{side.text}</div>
    </div>
  )
}
