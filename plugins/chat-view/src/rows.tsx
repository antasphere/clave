import type React from 'react'
import { useRef, useState, type RefObject } from 'react'
import {
  Virtualizer,
  type VirtualizerHandle,
  type CustomContainerComponent,
  type CustomContainerComponentProps,
  type CustomItemComponent
} from 'virtua'

/** The rows' box, sized and positioned by the virtualiser; the class is what
 *  the stylesheet hangs the column's rhythm and entrance on. */
function RowsBox({ style, children, ref }: CustomContainerComponentProps): React.JSX.Element {
  return (
    <div ref={ref} className="chat-rows" style={style}>
      {children}
    </div>
  )
}

/** What changed between the rows last rendered and these. */
interface Change<T> {
  rows: readonly T[]
  keys: ReadonlySet<string>
  settled: boolean
  /** Rows went in front of the ones already there: a page of the past. */
  shift: boolean
  /** Rows the column gained at its end, once the past had been read. */
  arriving: ReadonlySet<string>
}

function compare<T extends { key: string }>(
  before: Change<T> | null,
  rows: readonly T[],
  settled: boolean
): Change<T> {
  const keys = new Set(rows.map((row) => row.key))
  const arriving = new Set<string>()
  let shift = false
  if (before) {
    const first = rows.findIndex((row) => before.keys.has(row.key))
    const last = rows.findLastIndex((row) => before.keys.has(row.key))
    shift = first > 0
    if (before.settled)
      rows.forEach((row, i) => {
        if (i > last && !before.keys.has(row.key)) arriving.add(row.key)
      })
  }
  return { rows, keys, settled, shift, arriving }
}

/** The transcript's rows, only those near the viewport mounted: a long
 *  conversation keeps a screen or so of turns in the document rather than
 *  every markdown answer and tool run it ever held. The scroller stays the
 *  view's own `.chat-scroll`, so `useTranscriptEnd` and `useEarlier` keep
 *  measuring the element they always did.
 *
 *  Two things are read off the rows last rendered: whether this render put
 *  rows in front of them (a page of the past: `shift`, which keeps the
 *  reader's place from the end while the rows above are laid out), and which
 *  rows it added at the end once the view had read its past (`settled`).
 *  Those arrive: `children` is told so, and a row freezes that at its mount,
 *  since virtualised, a row mounts again each time it scrolls back into view
 *  and must not play its entrance again. The rows a view opens on and a page
 *  put in front later are the past, never arrivals.
 *
 *  The column's top padding sits above the rows and the virtualiser is not
 *  told of it: its idea of what is in view is off by that padding, well
 *  inside the buffer it renders around the viewport. */
export function TranscriptRows<T extends { key: string }>({
  rows,
  settled,
  scroll,
  as,
  item,
  holdAbove = false,
  children
}: {
  rows: readonly T[]
  settled: boolean
  scroll: RefObject<HTMLDivElement | null>
  /** Keep the row just above the viewport mounted. A row can paint past its
   *  own box: the Terminal view's pinned question is pushed out by the next
   *  one and hangs in the gap above it, still on screen after its exchange's
   *  box has left the top. The virtualiser keeps its buffer only in the
   *  direction of the scroll, so it unmounted that row there and then, and the
   *  question blinked out mid-push. */
  holdAbove?: boolean
  as?: CustomContainerComponent
  item?: CustomItemComponent
  children: (row: T, index: number, arrive: boolean) => React.ReactElement
}): React.JSX.Element {
  // Information from the previous render, kept the way React keeps it: in
  // state, updated during render when the rows change.
  const [change, setChange] = useState(() => compare(null, rows, settled))
  let current = change
  if (change.rows !== rows || change.settled !== settled) {
    current = compare(change, rows, settled)
    setChange(current)
  }
  const { shift, arriving } = current
  const handle = useRef<VirtualizerHandle>(null)
  const [held, setHeld] = useState<number | null>(null)
  const onScroll = holdAbove
    ? (offset: number): void => {
        const first = handle.current?.findItemIndex(offset) ?? 0
        const above = first > 0 ? first - 1 : null
        if (above !== held) setHeld(above)
      }
    : undefined
  return (
    <Virtualizer
      ref={handle}
      data={rows}
      scrollRef={scroll}
      shift={shift}
      as={as ?? RowsBox}
      item={item}
      onScroll={onScroll}
      keepMounted={held !== null && held < rows.length ? [held] : undefined}
    >
      {(row: T, index: number) => children(row, index, arriving.has(row.key))}
    </Virtualizer>
  )
}
