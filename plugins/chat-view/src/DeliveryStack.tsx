import { useMemo, useState, type CSSProperties } from 'react'
import { ArrowUpRightIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { requestJump } from './jump'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import { useSessionStore } from '../../../src/renderer/src/store/session-store'
import { useDisclosure } from './disclosure'
import { digestMessages, gist, useExchange, useExchanges, type ExchangeSide } from './exchanges'
import { digestKey } from '../../../src/shared/exchange-digest'
import { useDigestState } from './digest'
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
 * (`indexExchanges`, by the tabs' ids). At its head, the digest: what the
 * reader needs from these messages, read once they hold still and filed by tab (`useTimelineDigests`),
 * the card it came from marked in accent. The timeline holds the messages ALONE:
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
  const { sessionId, index, recent } = useExchanges()
  // What the digest reads, and so its key; the view asks for it
  // (`useTimelineDigests`), this only shows where it stands.
  const key = useMemo(() => digestKey(digestMessages(group, index)), [group, index])
  const digest = useDigestState(sessionId, key, recent.has(id))
  const done = digest.state === 'done' ? digest.result : null
  const flagged = done?.needsYou ? done.message : null
  return (
    <section
      className="chat-delivery-stack exchange-timeline"
      data-messages={count}
      data-digest={digest.state}
      data-digest-fresh={(digest.state === 'done' && digest.fresh) || undefined}
      data-needs-you={done?.needsYou || undefined}
      aria-label={`${count} ${count === 1 ? 'message' : 'messages'} from ${names.join(', ')}`}
    >
      <header className="exchange-head">
        <ExchangeDrawing />
        <span className="exchange-title">
          <span className="exchange-eyebrow">
            From <span className="exchange-names">{names.join(', ')}</span>
          </span>
          <span className="exchange-digest" aria-live="polite">
            <span className="exchange-digest-inner">
              {digest.state === 'reading' ? (
                <span className="exchange-digest-reading">Reading what matters for you…</span>
              ) : done ? (
                <DigestLine
                  summary={done.summary}
                  needsYou={done.needsYou}
                  onOpen={
                    flagged === null ? undefined : (event) => openCard(event.currentTarget, flagged)
                  }
                />
              ) : null}
            </span>
          </span>
        </span>
      </header>
      <ol className="exchange-list">
        {group.messages.map((message, order) => (
          <ExchangeCard
            key={order}
            message={message}
            id={`${id}-${order}`}
            order={order}
            needsYou={flagged === order}
          />
        ))}
      </ol>
    </section>
  )
}

/** The digest under the senders. Something for the reader: the drawings'
 *  ringed marker beside the words (a column of its own, so a second line
 *  stands under the first, not under the marker), on a breath of accent, and
 *  a click opens the card it came from. Nothing: a quiet line. */
function DigestLine({
  summary,
  needsYou,
  onOpen
}: {
  summary: string
  needsYou: boolean
  onOpen?: (event: React.MouseEvent<HTMLElement>) => void
}): React.JSX.Element {
  const words = <span className="exchange-digest-words">{summary}</span>
  if (!needsYou)
    return (
      <span className="exchange-digest-text" title="Read by Haiku from the messages below">
        {words}
      </span>
    )
  const mark = (
    <svg className="chat-drawing exchange-digest-mark" viewBox="0 0 14 14" aria-hidden="true">
      <circle className="ring" cx="7" cy="7" r="5.6" />
      <circle className="dot dot--c" cx="7" cy="7" r="2.4" />
    </svg>
  )
  return onOpen ? (
    <button
      type="button"
      className="exchange-digest-text"
      data-needs-you=""
      title="Open the message this comes from"
      onClick={onOpen}
    >
      {mark}
      {words}
    </button>
  ) : (
    <span className="exchange-digest-text" data-needs-you="">
      {mark}
      {words}
    </span>
  )
}

/** Open the timeline's card at `index` and bring it into view, smoothly. */
function openCard(from: HTMLElement, index: number): void {
  const card = from
    .closest('.exchange-timeline')
    ?.querySelectorAll<HTMLDetailsElement>('details.exchange-card')[index]
  if (!card) return
  card.open = true
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function ExchangeCard({
  message,
  id,
  order,
  needsYou
}: {
  message: DeliveryEntry
  id: string
  /** Its place in the timeline, for the arrival's stagger. */
  order: number
  /** The digest found what the reader needs in this message. */
  needsYou: boolean
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
      data-needs-you={needsYou || undefined}
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
              {delivery?.sender?.id && (
                <OpenThere id={delivery.sender.id} name={name} text={body} />
              )}
            </>
          )}
        </div>
      </details>
    </li>
  )
}

/** Opens the other tab at this exchange: it finds the words there (jump.ts)
 *  once it is on screen, reading its older history if it must. */
function openAt(sessionId: string, text: string): void {
  requestJump(sessionId, text)
  useSessionStore.getState().selectSession(sessionId, false)
}

/** The opened card's way to the other side of the exchange, when that tab is
 *  in this window. */
function OpenThere({
  id,
  name,
  text
}: {
  id: string
  name: string
  text: string
}): React.JSX.Element | null {
  const here = useSessionStore((state) => state.sessions.some((s) => s.id === id))
  if (!here) return null
  return (
    <button type="button" className="exchange-open" onClick={() => openAt(id, text)}>
      Open in {name}
      <ArrowUpRightIcon aria-hidden="true" />
    </button>
  )
}

/** One piece of writing in an opened exchange: who wrote it and when, then the
 *  words, in the transcript's own type. The other tab's name opens it at this
 *  exchange when it is in this window. */
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
            title={`Open “${who}” at this exchange`}
            onClick={() => openAt(from, side.text)}
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
