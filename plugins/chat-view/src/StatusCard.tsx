import { memo, useContext } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { statusNeedsYou, type StatusCard as Status } from '../../../src/shared/status-card'
import { createEntryMarkdownPlugins } from './markdown-append'
import type { Entry } from './reducer'
import { CurrentCardContext } from './status-current'
import './status-card.css'

/* The status card (PRDCT-5166): what the agent's answer ended on, when its
   writing style asks for one, drawn under the answer in the Chat, Terminal
   and Folio views alike. The reducer took the block out of the answer's
   text (`readStatusCard`); this draws what it read and nothing else. It
   answers nothing and offers no click: a reader must never take it for a
   control. The accent goes once, on what the person must do; a status the
   person has since answered (`past`) keeps every word, in muted ink. */

/** A field's prose, as inline markdown limited to code, emphasis and strong:
 *  an agent writes `main` in backticks, and the card never shows them raw,
 *  nor a block, a link or HTML it was not meant to hold. */
const INLINE = ['p', 'code', 'em', 'strong']
const PLUGINS = createEntryMarkdownPlugins(false)
const COMPONENTS: Components = { p: ({ children }) => <>{children}</> }
function Inline({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={PLUGINS}
      allowedElements={INLINE}
      unwrapDisallowed
      components={COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  )
}

export const StatusCard = memo(function StatusCard({
  card,
  past = false
}: {
  card: Status
  past?: boolean
}): React.JSX.Element {
  const owed = statusNeedsYou(card)
  // The accent's one place: the next step when there is one, else the
  // decisions; never on a status already answered.
  const accent = past || !owed ? null : card.next !== null ? 'next' : 'decide'
  return (
    <section
      className="status-card"
      data-testid="status-card"
      data-needs-you={owed ? 'true' : 'false'}
      data-past={past ? 'true' : undefined}
      aria-label="Status"
    >
      {card.doing !== null && (
        <p className="status-card-doing status-card-field">
          <Inline text={card.doing} />
        </p>
      )}
      {card.where !== null && (
        <p className="status-card-where status-card-field">
          <Inline text={card.where} />
        </p>
      )}
      {card.decide.length > 0 && (
        <div className="status-card-decide">
          <p className="status-card-label" data-accent={accent === 'decide' ? 'true' : undefined}>
            To decide
          </p>
          <ul>
            {card.decide.map((decision, i) => (
              <li key={i} className="status-card-field">
                <Inline text={decision} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.next !== null ? (
        <p className="status-card-next">
          <span className="status-card-label" data-accent={accent === 'next' ? 'true' : undefined}>
            Next
          </span>
          <span className="status-card-field">
            <Inline text={card.next} />
          </span>
        </p>
      ) : (
        !owed && <p className="status-card-next status-card-quiet">Nothing needed from you</p>
      )}
    </section>
  )
})

/** The card of an answer in the transcript, past or current as its view
 *  says (`CurrentCardContext`). Its own component, so a message of the
 *  person re-renders the cards and never the answers' markdown. */
export function EntryStatusCard({
  entry,
  card
}: {
  entry: Entry
  card: Status
}): React.JSX.Element {
  const current = useContext(CurrentCardContext)
  return <StatusCard card={card} past={current !== undefined && current !== entry} />
}
