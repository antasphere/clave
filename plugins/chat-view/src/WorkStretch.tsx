import { useContext, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { workDigestKey } from '../../../src/shared/work-digest'
import { useDisclosure } from './disclosure'
import { useWorkDigestState } from './digest'
import {
  countsLabel,
  noteCount,
  plainNote,
  spanLabel,
  stretchNotes,
  stretchSpan,
  toolCount,
  type Row,
  type WorkStretch as Stretch
} from './stretches'
import { StretchContext } from './stretch-context'
import type { Block } from './tools'

/**
 * The agent's WORKING NOTES, folded into one card once the turn is over
 * (`stretches.ts` decides what folds; this draws it, PRDCT-4212). Closed, the
 * card is one line the reader understands without opening it: a drawing of
 * notes folding into one line, the title the work digest read (until it
 * lands, the first note's first line), and the counts beneath. When the
 * digest found a note that asked the reader something or changed the plan,
 * that note is on the face whole (its markup dropped), in accent, and its step is marked
 * inside. Open, the card is a rail of steps, one node each: what the agent
 * said, in the transcript's own rows, then what it did under it. The rows
 * inside are the view's own (`render`), so a note reads as a note does and a
 * run of tools opens as it does anywhere else.
 *
 * Motion: a card whose stretch just ended settles in (`data-fresh`, the
 * forms' arrival), opening glides to the body's height and the steps rise one
 * after another; a reader who asked for no motion keeps the fades and loses
 * the travel. A card scrolled back into view mounts again and plays nothing.
 */

/** A card is fresh when its stretch ended moments ago: it has just folded
 *  under the reader's eyes and settles in. Older, it mounts still. */
const FRESH_MS = 20_000

export function WorkStretch({
  stretch,
  id,
  render
}: {
  stretch: Stretch
  /** The row's key: the card's disclosure and its digest are kept under it. */
  id: string
  /** The view's own row for a block inside the card. */
  render: (block: Block | Row, key: string) => ReactNode
}): React.JSX.Element {
  const { sessionId, recent } = useContext(StretchContext)
  const notes = useMemo(() => stretchNotes(stretch), [stretch])
  const tools = toolCount(stretch)
  const span = stretchSpan(stretch)
  const key = useMemo(() => workDigestKey(notes), [notes])
  const digest = useWorkDigestState(sessionId, key, recent.has(id))
  const done = digest.state === 'done' ? digest.result : null
  const flagged = done?.needsYou ? done.note : null
  const [fresh] = useState(() => Date.now() - span.to < FRESH_MS)
  const disclosure = useDisclosure(id)
  const [built, setBuilt] = useState(disclosure.initial)
  // Built on approach (hover or focus), as a tool call's panel is, so the
  // steps are there before the card opens: the height glides to their real
  // size and they stagger in, rather than opening onto nothing and popping.
  const build = (): void => setBuilt(true)
  // The steps that count as notes, in order, so a flagged note's number
  // (the digest counts notes alone) finds its step.
  const noteSteps = stretch.steps.filter((step) => step.note !== null && step.work.length > 0)
  const flaggedStep = flagged === null ? null : noteSteps[flagged]
  const title = done?.title ?? plainNote(notes[0] ?? '', true)
  return (
    <section
      className="work-stretch"
      data-notes={noteCount(stretch.steps)}
      data-tools={tools}
      data-digest={digest.state}
      data-digest-fresh={(digest.state === 'done' && digest.fresh) || undefined}
      data-needs-you={flaggedStep ? 'true' : undefined}
      data-fresh={fresh || undefined}
      aria-label={`The agent's working notes, ${countsLabel(noteCount(stretch.steps), tools, spanLabel(span.from, span.to))}`}
    >
      <details
        className="stretch-card"
        open={disclosure.initial}
        onToggle={(event) => {
          if (disclosure.toggle(event)) setBuilt(true)
        }}
      >
        <summary className="stretch-summary" onPointerEnter={build} onFocus={build}>
          <StretchDrawing />
          <span className="stretch-words">
            <span className="stretch-eyebrow">
              {countsLabel(noteCount(stretch.steps), tools, spanLabel(span.from, span.to))}
            </span>
            <span
              className="stretch-title"
              data-read={done ? 'true' : undefined}
              title={done ? 'Read by Haiku from the notes inside' : undefined}
            >
              {/* Keyed on the words, so a title landing settles in over the first note. */}
              <span key={title} className="stretch-title-words">
                {title || 'The agent worked'}
              </span>
            </span>
            {flaggedStep?.note && (
              <span className="stretch-flag" aria-label="A note needs you">
                <svg
                  className="chat-drawing stretch-flag-mark"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
                  <circle className="ring" cx="7" cy="7" r="5.6" />
                  <circle className="dot dot--c" cx="7" cy="7" r="2.4" />
                </svg>
                <span className="stretch-flag-words">{plainNote(flaggedStep.note.text)}</span>
              </span>
            )}
          </span>
          <ChevronDownIcon className="stretch-chevron" aria-hidden="true" />
        </summary>
        <div className="stretch-body">
          {built && (
            <ol className="stretch-steps">
              {stretch.steps.map((step, i) => (
                <li
                  key={i}
                  className="stretch-step"
                  data-needs-you={step === flaggedStep ? 'true' : undefined}
                  data-silent={step.note === null ? 'true' : undefined}
                  style={{ '--stretch-i': Math.min(i, 8) } as CSSProperties}
                >
                  <span className="stretch-node" aria-hidden="true" />
                  <div className="stretch-step-body">
                    {step.note && render(step.note, `${id}-note-${i}`)}
                    {step.work.map((block, j) => render(block, `${id}-work-${i}-${j}`))}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </details>
    </section>
  )
}

/* The drawing at the head of a card, in the hand of the exchange timeline's
   and the work cards' (`ExchangeDrawing`, `WorkDrawing`): ink at low opacity,
   a box filled with a breath of paper, the accent used ONCE. Literal: a sheet
   of notes, four lines, folding down into one line that runs out to the
   ringed dot, the title. While the digest reads, the accent travels the
   folding line; when a note needs the reader, the landing dot is in accent.
   Words never go inside a drawing: the card says them beside. */
export function StretchDrawing(): React.JSX.Element {
  return (
    <svg viewBox="0 0 48 40" className="chat-drawing stretch-drawing" aria-hidden="true">
      {/* the sheet of notes */}
      <rect className="bx bx--front" x="4" y="5" width="22" height="30" rx="3.5" />
      <line className="ln ln--thin stretch-note" x1="9" y1="12" x2="21" y2="12" />
      <line className="ln ln--thin stretch-note" x1="9" y1="17.5" x2="18" y2="17.5" />
      <line className="ln ln--thin stretch-note" x1="9" y1="23" x2="20" y2="23" />
      <line className="ln ln--thin stretch-note" x1="9" y1="28.5" x2="16" y2="28.5" />
      {/* the fold: the notes gathered into one line, out to the title */}
      <path className="ln ln--c stretch-fold" pathLength={1} d="M26,12 C31,12 31,20 35,20 L39,20" />
      <circle className="ring" cx="41.5" cy="20" r="3.4" />
      <circle className="dot dot--c stretch-land" cx="41.5" cy="20" r="1.5" />
    </svg>
  )
}
