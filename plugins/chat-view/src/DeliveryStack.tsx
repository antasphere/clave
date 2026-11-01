import { useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDownIcon, ArrowTurnDownRightIcon } from '@heroicons/react/24/outline'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import { useDisclosure } from './disclosure'
import type { DeliveryGroup, DeliveryExchange, ExchangeResponse } from './tools'

type RenderEntry = (entry: DeliveryExchange['message'] | ExchangeResponse) => ReactNode

const sender = (exchange: DeliveryExchange): string =>
  parseDelivery(exchange.message.text)?.sender?.name ?? 'Another agent'

/** One deck contains whole peer exchanges. The closed faces show only short
 *  previews; full messages and their replies mount when the reader opens it. */
export function DeliveryStack({
  group,
  id,
  renderEntry
}: {
  group: DeliveryGroup
  id: string
  renderEntry: RenderEntry
}): React.JSX.Element {
  const disclosure = useDisclosure(id)
  const [built, setBuilt] = useState(disclosure.initial)
  const names = [...new Set(group.exchanges.map(sender))].join(', ')
  const count = group.exchanges.length
  const first = group.exchanges[0]
  const preview = parseDelivery(first.message.text)?.body.trim().split('\n')[0] ?? ''
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
        aria-label={`${count} ${count === 1 ? 'exchange' : 'exchanges'} with ${names}`}
      >
        <span className="chat-delivery-peeks" aria-hidden="true">
          {group.exchanges.slice(1, 3).map((exchange, index) => (
            <span
              key={index}
              className="chat-delivery-peek"
              style={{ '--delivery-layer': index + 1 } as CSSProperties}
            >
              <span>{sender(exchange)}</span>
            </span>
          ))}
        </span>
        <span className="chat-delivery-cover">
          <span className="chat-delivery-heading">
            <span className="chat-delivery-eyebrow">
              <ArrowTurnDownRightIcon aria-hidden="true" /> Agent conversation
            </span>
            <span className="chat-delivery-count">
              {count} {count === 1 ? 'exchange' : 'exchanges'}
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
          group.exchanges.map((exchange, index) => (
            <section className="chat-exchange-card" key={index}>
              <div className="chat-exchange-message">{renderEntry(exchange.message)}</div>
              {exchange.responses.length > 0 && (
                <div className="chat-exchange-responses">
                  <span className="chat-exchange-response-label">This session</span>
                  {exchange.responses.map((entry, i) => (
                    <div key={entry.kind === 'tool-group' ? entry.id : i}>{renderEntry(entry)}</div>
                  ))}
                </div>
              )}
            </section>
          ))}
      </div>
    </details>
  )
}
