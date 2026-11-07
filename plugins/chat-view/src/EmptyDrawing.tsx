import type React from 'react'
import './empty.css'

/* The empty conversation, for Chat and Enclave, in the hand of Folio's open
   book and the drop card (`DropDrawing`, the `.chat-drawing` rules): ink at
   low opacity, paper boxes, the ringed dot as the focal marker, the accent
   ONCE, on the line being written, which draws itself as the pane comes up
   and ends on the pen. Still for a reader who asked for no motion. Words
   never go inside a drawing: the empty state says them underneath.

   - chat: the reader's message on the right, a paper bubble; the answer on
     the left, its first lines ruled and waiting, the one being written in the
     accent; the composer on the ground line below.
   - enclave: one quiet column, the rail down its left, a step per node, each
     a line of what was done; the last node is where the next step will be
     written. */

export type EmptyKind = 'chat' | 'enclave'

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

export function EmptyDrawing({ kind }: { kind: EmptyKind }): React.JSX.Element {
  return (
    <svg viewBox="0 0 240 150" className="chat-drawing view-empty-drawing" aria-hidden="true">
      <line className="ln ln--thin" x1="18" y1="138" x2="222" y2="138" />
      {kind === 'chat' ? (
        <>
          {/* the reader's message, a paper bubble on the right */}
          <rect className="bx bx--front" x="118" y="14" width="88" height="24" rx="12" />
          <line className="ln" x1="132" y1="26" x2="184" y2="26" />
          {/* the answer, ruled and waiting on the left */}
          <line className="ln ln--soft" x1="34" y1="70" x2="150" y2="70" />
          <line className="ln ln--soft" x1="34" y1="82" x2="128" y2="82" />
          {/* the line being written, and the pen at its end */}
          <path className="ln ln--c travel" pathLength={1} d="M34,56 C60,55 90,56 116,55" />
          <Pen x={123} y={55} />
          {/* the composer, on the ground */}
          <rect className="bx bx--front" x="34" y="102" width="172" height="26" rx="9" />
          <line className="ln ln--thin" x1="48" y1="115" x2="120" y2="115" />
          <circle className="dot" cx="191" cy="115" r="4" />
        </>
      ) : (
        <>
          {/* the rail, and a step per node: what was done, one line each */}
          <line className="ln ln--thin" x1="52" y1="18" x2="52" y2="112" />
          {[22, 46, 70].map((y, i) => (
            <g key={y} className="view-empty-step" style={{ animationDelay: `${120 + i * 120}ms` }}>
              <circle className="bx bx--front" cx="52" cy={y} r="5" />
              <circle className="dot dot--seat" cx="52" cy={y} r="2" />
              <line className="ln ln--thin" x1="66" y1={y} x2={170 - i * 22} y2={y} />
              {i === 1 && <rect className="bx" x="66" y={y + 6} width="84" height="10" rx="3" />}
            </g>
          ))}
          {/* where the next step is being written */}
          <path className="ln ln--c travel" pathLength={1} d="M66,96 C96,95 126,96 152,95" />
          <Pen x={52} y={96} />
          <circle className="dot dot--c" cx="159" cy="95" r="2" />
        </>
      )}
    </svg>
  )
}

/** The empty state of a conversation view: the drawing, its name, one line. */
export function ViewEmpty({
  kind,
  eyebrow,
  title,
  text
}: {
  kind: EmptyKind
  eyebrow: string
  title: string
  text: string
}): React.JSX.Element {
  return (
    <div className="chat-empty view-empty" data-empty-kind={kind}>
      <EmptyDrawing kind={kind} />
      <p className="chat-drop-eyebrow">{eyebrow}</p>
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  )
}
