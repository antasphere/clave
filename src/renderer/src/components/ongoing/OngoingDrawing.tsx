import type React from 'react'

/* The Ongoing page's empty state, in the hand of the conversation views'
   drawings (`plugins/chat-view/src/EmptyDrawing.tsx`, the `.chat-drawing`
   rules in packages/ui system.css): ink at low opacity, paper boxes, the
   ringed dot as the focal marker, the accent ONCE.

   What it shows: a conversation that goes on. Two exchanges already had,
   paper bubbles on a thread that runs down the page; the thread does not
   stop at the last one, it carries on to where the next exchange will be,
   drawn in the accent and ending on the pen. A tab put aside, still open.
   Words never go inside a drawing: the page says them underneath. The same
   drawing heads the page beside its title once it holds a conversation. */

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

export function OngoingDrawing({ className }: { className?: string } = {}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 240 150"
      className={`chat-drawing ongoing-drawing${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    >
      <line className="ln ln--thin" x1="18" y1="138" x2="222" y2="138" />
      {/* the thread the exchanges hang on */}
      <path className="ln ln--soft" d="M58,20 C58,46 58,70 58,96" />
      {/* an exchange from a while ago: theirs on the left, quieter */}
      <g className="ongoing-drawing-step" style={{ animationDelay: '80ms' }}>
        <circle className="bx bx--front" cx="58" cy="22" r="4.5" />
        <circle className="dot dot--seat" cx="58" cy="22" r="1.8" />
        <rect className="bx" x="72" y="12" width="78" height="20" rx="10" />
        <line className="ln ln--thin" x1="84" y1="22" x2="132" y2="22" />
      </g>
      {/* the last one had: yours, on paper, in front */}
      <g className="ongoing-drawing-step" style={{ animationDelay: '200ms' }}>
        <circle className="bx bx--front" cx="58" cy="58" r="4.5" />
        <circle className="dot dot--seat" cx="58" cy="58" r="1.8" />
        <rect className="bx bx--front" x="72" y="44" width="112" height="28" rx="12" />
        <line className="ln" x1="86" y1="54" x2="164" y2="54" />
        <line className="ln ln--thin" x1="86" y1="63" x2="140" y2="63" />
      </g>
      {/* and the thread going on to the next one, being written in the accent */}
      <circle className="bx bx--front" cx="58" cy="100" r="4.5" />
      <circle className="dot dot--seat" cx="58" cy="100" r="1.8" />
      <path className="ln ln--c travel" pathLength={1} d="M72,100 C98,99 124,100 150,99" />
      <Pen x={157} y={99} />
    </svg>
  )
}
