import { useState, type ReactNode } from 'react'
import { ChevronRightIcon, RectangleStackIcon } from '@heroicons/react/24/outline'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import { useDisclosure } from './disclosure'
import type { DeliveryGroup } from './tools'

/** The transcript still owns every message. Only its presentation folds;
 *  unopened stacks do not mount their long bodies. */
export function DeliveryStack({
  group,
  id,
  children
}: {
  group: DeliveryGroup
  id: string
  children: ReactNode
}): React.JSX.Element {
  const disclosure = useDisclosure(id)
  const [built, setBuilt] = useState(disclosure.initial)
  const names = [
    ...new Set(
      group.entries.map((entry) => parseDelivery(entry.text)?.sender?.name ?? 'Another agent')
    )
  ].join(', ')
  const count = group.entries.length
  return (
    <details
      className="chat-delivery-stack"
      data-messages={count}
      open={disclosure.initial}
      onToggle={(event) => {
        if (disclosure.toggle(event)) setBuilt(true)
      }}
    >
      <summary className="chat-tool-row chat-delivery-summary">
        <ChevronRightIcon className="chat-delivery-chevron" aria-hidden="true" />
        <RectangleStackIcon className="chat-tool-status" aria-hidden="true" />
        <span className="chat-delivery-count">
          {count} {count === 1 ? 'message' : 'messages'} from
        </span>
        <span className="chat-delivery-senders" title={names}>
          {names}
        </span>
      </summary>
      {built && <div className="chat-delivery-items">{children}</div>}
    </details>
  )
}
