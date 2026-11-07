/* The drawing at the head of an exchange timeline, in the hand of the drop
   card's and the work cards' figures (`DropDrawing`, `WorkDrawing`): ink at
   low opacity, boxes filled with a breath of paper, the accent used ONCE, on
   the one line that carries the meaning. Literal: two tabs side by side, the
   message travelling from one to the other along the accent arc and landing
   on the ringed dot; the way back, the reply, dashed under them. The arc draws
   itself once as the timeline arrives (`.exchange-drawing` in system.css); a
   reader who asked for no motion gets the still drawing. Words never go inside
   a drawing: the timeline says them beside. */

export function ExchangeDrawing(): React.JSX.Element {
  return (
    <svg viewBox="0 0 48 40" className="chat-drawing exchange-drawing" aria-hidden="true">
      {/* the two tabs, each with a line of what it is saying */}
      <rect className="bx bx--front" x="3" y="13" width="15" height="19" rx="3.5" />
      <line className="ln ln--thin" x1="7" y1="20" x2="14" y2="20" />
      <line className="ln ln--thin" x1="7" y1="25" x2="12" y2="25" />
      <rect className="bx bx--front" x="30" y="13" width="15" height="19" rx="3.5" />
      <line className="ln ln--thin" x1="34" y1="20" x2="41" y2="20" />
      <line className="ln ln--thin" x1="34" y1="25" x2="39" y2="25" />
      {/* the message, across the top, landing where the ring waits */}
      <path className="ln ln--c exchange-arc" pathLength={1} d="M12,12 C16,2 30,2 35.5,9.5" />
      <circle className="ring" cx="37.5" cy="11" r="3.4" />
      <circle className="dot dot--c exchange-land" cx="37.5" cy="11" r="1.5" />
      {/* the reply, back along the bottom, dashed */}
      <path className="ln ln--soft" d="M36,34 C31,39 17,39 12,34" />
    </svg>
  )
}
