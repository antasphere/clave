import { useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDownIcon, ArrowTurnDownRightIcon } from '@heroicons/react/24/outline'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import { useDisclosure } from './disclosure'
import type { DeliveryEntry, DeliveryGroup } from './tools'

const sender = (message: DeliveryEntry): string =>
  parseDelivery(message.text)?.sender?.name ?? 'Another agent'

/** One deck holds the consecutive messages other tabs sent, and nothing the
 *  agent said back: its replies, its progress and its questions to the reader
 *  stay in the transcript beside the deck. The closed faces show only short
 *  previews; the full messages mount when the reader opens it. */
export function DeliveryStack({
  group,
  id,
  renderEntry
}: {
  group: DeliveryGroup
  id: string
  renderEntry: (message: DeliveryEntry) => ReactNode
}): React.JSX.Element {
  const disclosure = useDisclosure(id)
  const [built, setBuilt] = useState(disclosure.initial)
  const names = [...new Set(group.messages.map(sender))].join(', ')
  const count = group.messages.length
  const preview = parseDelivery(group.messages[0].text)?.body.trim().split('\n')[0] ?? ''
  const layers = Math.min(count - 1, 2)
  return (
    <details
      className="chat-delivery-stack"
      data-messages={count}
      style={{ '--delivery-layers': layers } as CSSProperties}
      open={disclosure.initial}
      onToggle={(event) => {
        if (disclosure.toggle(event)) setBuilt(true)
      }}
    >
      <summary
        className="chat-delivery-summary"
        aria-label={`${count} ${count === 1 ? 'message' : 'messages'} from ${names}`}
      >
        <span className="chat-delivery-peeks" aria-hidden="true">
          {group.messages.slice(1, 3).map((message, index) => (
            <span
              key={index}
              className="chat-delivery-peek"
              style={{ '--delivery-layer': index + 1 } as CSSProperties}
            >
              <span>{sender(message)}</span>
            </span>
          ))}
        </span>
        <span className="chat-delivery-cover">
          <span className="chat-delivery-heading">
            <span className="chat-delivery-eyebrow">
              <ArrowTurnDownRightIcon aria-hidden="true" /> Agent conversation
            </span>
            <span className="chat-delivery-count">
              {count} {count === 1 ? 'message' : 'messages'}
            </span>
            <ChevronDownIcon className="chat-delivery-chevron" aria-hidden="true" />
          </span>
          <span className="chat-delivery-senders" title={names}>
            {names}
          </span>
          <span className="chat-delivery-preview">{preview || 'Message from another session'}</span>
        </span>
      </summary>
      <div className="chat-delivery-items">
        {built &&
          group.messages.map((message, index) => (
            <section className="chat-exchange-card" key={index}>
              <div className="chat-exchange-message">{renderEntry(message)}</div>
            </section>
          ))}
      </div>
    </details>
  )
}
