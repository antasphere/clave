import type React from 'react'
import './pane-empty.css'

/* The main pane with nothing in it, in the hand of the app's other empty
   states (the conversation's `EmptyDrawing`, Ongoing's drawing, the drop
   card: the `.chat-drawing` rules in packages/ui system.css): ink at low
   opacity, paper boxes, the ringed dot as the focal marker, the accent ONCE,
   on the line that draws itself as the pane comes up and ends on the pen.
   Still for a reader who asked for no motion. Words never go inside a
   drawing: the pane says them underneath (PRDCT-4487).

   - select: sessions are open, none is picked. The sidebar's rows on the
     left, one of them picked, on paper; from it the accent runs into the
     empty pane on the right, a dashed frame, and lands where the session
     will open.
   - none: no session at all. The sidebar holds only the key that starts
     one, its list still to come; the accent runs from the key into the same
     empty pane. */

export type PaneEmptyKind = 'select' | 'none'

const WORDS: Record<PaneEmptyKind, { title: string; text: string }> = {
  // The title is the one the e2e specs wait on (fleet-workspace-files).
  select: { title: 'Select a session', text: 'Pick one in the sidebar and it opens here.' },
  none: { title: 'No active sessions', text: 'Start one and it opens here.' }
}

/** Where the session will open: the paper, the ring, its pulse, the dot. */
function Pen({ x, y }: { x: number; y: number }): React.JSX.Element {
  return (
    <g>
      <circle className="bx bx--front" cx={x} cy={y} r="7" />
      <circle className="ring" cx={x} cy={y} r="7" />
      <circle className="ring ring--pulse" cx={x} cy={y} r="7" />
      <circle className="dot dot--c" cx={x} cy={y} r="2.8" />
    </g>
  )
}

/** One step of the sidebar, arriving in its turn. */
function Step({
  delay,
  children
}: {
  delay: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <g className="pane-empty-step" style={{ animationDelay: `${delay}ms` }}>
      {children}
    </g>
  )
}

/** The rows of the 'select' drawing: their height, and how far each name runs. */
const ROWS = [
  { y: 36, end: 80 },
  { y: 58, end: 84, picked: true },
  { y: 80, end: 70 },
  { y: 102, end: 76 }
]

export function PaneEmptyDrawing({ kind }: { kind: PaneEmptyKind }): React.JSX.Element {
  // The accent leaves the picked row (or the key) at its right end and lands
  // on the pen in the middle of the pane.
  const from = kind === 'select' ? 58 : 36
  return (
    <svg viewBox="0 0 240 150" className="chat-drawing pane-empty-drawing" aria-hidden="true">
      <line className="ln ln--thin" x1="18" y1="138" x2="222" y2="138" />
      {/* the sidebar: its group's name at the head */}
      <line className="ln ln--thin" x1="24" y1="16" x2="52" y2="16" />
      {kind === 'select'
        ? ROWS.map((row, i) => (
            <Step key={row.y} delay={80 + i * 80}>
              {row.picked ? (
                <>
                  <rect
                    className="bx bx--front"
                    x="20"
                    y={row.y - 10}
                    width="78"
                    height="20"
                    rx="10"
                  />
                  <circle className="dot" cx="30" cy={row.y} r="2.4" />
                  <line className="ln" x1="38" y1={row.y} x2={row.end} y2={row.y} />
                </>
              ) : (
                <>
                  <circle className="dot dot--seat" cx="30" cy={row.y} r="2.2" />
                  <line className="ln ln--thin" x1="38" y1={row.y} x2={row.end} y2={row.y} />
                </>
              )}
            </Step>
          ))
        : [
            <Step key="key" delay={80}>
              {/* the key that starts a session: a plus and its word */}
              <rect className="bx bx--front" x="20" y="26" width="78" height="20" rx="10" />
              <line className="ln" x1="27" y1="36" x2="33" y2="36" />
              <line className="ln" x1="30" y1="33" x2="30" y2="39" />
              <line className="ln ln--thin" x1="40" y1="36" x2="80" y2="36" />
            </Step>,
            // the list still to come, ruled and waiting
            ...[64, 86].map((y, i) => (
              <Step key={y} delay={160 + i * 80}>
                <line className="ln ln--soft" x1="26" y1={y} x2={i ? 70 : 82} y2={y} />
              </Step>
            ))
          ]}
      {/* the pane, empty: a dashed frame */}
      <rect className="ln ln--soft" x="114" y="12" width="108" height="114" rx="10" />
      {/* the way in, in the accent, and where it lands */}
      <path
        className="ln ln--c travel"
        pathLength={1}
        d={`M100,${from} C126,${from} 138,69 160.5,69`}
      />
      <Pen x={168} y={69} />
    </svg>
  )
}

/** The pane's empty state: the drawing, what is missing, one sentence, and
 *  the key that starts a session when there is none. */
export function PaneEmpty({
  kind,
  action
}: {
  kind: PaneEmptyKind
  action?: React.ReactNode
}): React.JSX.Element {
  const words = WORDS[kind]
  return (
    <div className="pane-empty" data-pane-empty={kind}>
      <PaneEmptyDrawing kind={kind} />
      <strong>{words.title}</strong>
      <span>{words.text}</span>
      {action}
    </div>
  )
}
