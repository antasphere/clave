/* The drawings of the question card (`InputPrompt`), in the hand of the
   chat's figures (`DropDrawing`, `ExchangeDrawing`, the `.chat-drawing`
   rules): ink at low opacity, paper boxes, the ringed dot as the focal marker,
   the accent used ONCE, on the line that carries the meaning. Each draws
   itself once as the card arrives; a reader who asked for no motion gets the
   still drawing. Words never go inside a drawing: the card says them beside.

   - AskDrawing, at the head of the card: the agent's bubble on the left with
     its question mark, the reader's sheet on the right with its ruled lines,
     the fields to fill; the accent line leaves the bubble and lands on the
     sheet's first line, where the ringed dot waits for the first answer.
   - LinkDrawing, beside a link to open and come back from: the card, a
     browser window, the accent line out to the window, the way back dashed. */

export function AskDrawing(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 120 84"
      className="chat-drawing ask-drawing ask-drawing--ask"
      aria-hidden="true"
    >
      <defs>
        <marker
          id="ask-head-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path className="head head--c" d="M1.5,1.5 L8,5 L1.5,8.5" />
        </marker>
      </defs>
      {/* the ground the sheet stands on */}
      <line className="ln ln--thin" x1="8" y1="78" x2="112" y2="78" />
      {/* the agent's bubble, with its question mark */}
      <path
        className="bx bx--front"
        d="M6,14 a7,7 0 0 1 7,-7 h30 a7,7 0 0 1 7,7 v18 a7,7 0 0 1 -7,7 h-19 l-8,8 v-8 h-3 a7,7 0 0 1 -7,-7 z"
      />
      <path className="ln" d="M22,19 c0,-4 10,-4 10,0 c0,3 -5,3 -5,7" />
      <circle className="dot" cx="27" cy="30" r="1.4" />
      {/* the reader's sheet, ruled: the fields to fill */}
      <rect className="bx bx--front" x="62" y="12" width="50" height="66" rx="6" />
      <line className="ln ln--thin" x1="71" y1="28" x2="103" y2="28" />
      <line className="ln ln--thin" x1="71" y1="42" x2="103" y2="42" />
      <line className="ln ln--thin" x1="71" y1="56" x2="97" y2="56" />
      <rect className="bx" x="84" y="64" width="19" height="7" rx="3.5" />
      {/* the one line that carries the meaning: the question becomes the first answer */}
      <path
        className="ln ln--c travel"
        pathLength={1}
        d="M50,24 C56,22 60,22 66,27"
        markerEnd="url(#ask-head-arrow)"
      />
      <circle className="bx bx--front" cx="71" cy="28" r="4.5" />
      <circle className="ring" cx="71" cy="28" r="4.5" />
      <circle className="ring ring--pulse" cx="71" cy="28" r="4.5" />
      <circle className="dot dot--c" cx="71" cy="28" r="1.9" />
    </svg>
  )
}

export function LinkDrawing(): React.JSX.Element {
  return (
    <svg viewBox="0 0 96 56" className="chat-drawing ask-drawing" aria-hidden="true">
      <defs>
        <marker
          id="ask-drawing-head"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path className="head head--c" d="M1.5,1.5 L8,5 L1.5,8.5" />
        </marker>
      </defs>
      {/* the card, with its one line and its send dot */}
      <rect className="bx bx--front" x="4" y="18" width="30" height="22" rx="6" />
      <line className="ln ln--thin" x1="11" y1="29" x2="24" y2="29" />
      <circle className="dot dot--seat" cx="28" cy="29" r="2" />
      {/* the browser window: a title bar and a page */}
      <rect className="bx bx--front" x="56" y="8" width="36" height="34" rx="5" />
      <line className="ln ln--thin" x1="56" y1="16" x2="92" y2="16" />
      <circle className="dot dot--seat" cx="61" cy="12" r="1.3" />
      <circle className="dot dot--seat" cx="65" cy="12" r="1.3" />
      <line className="ln ln--thin" x1="63" y1="26" x2="85" y2="26" />
      <line className="ln ln--thin" x1="63" y1="32" x2="79" y2="32" />
      {/* out to the window, along the accent, landing on the ringed dot */}
      <path
        className="ln ln--c travel"
        pathLength={1}
        d="M34,22 C42,12 50,8 60,6"
        markerEnd="url(#ask-drawing-head)"
      />
      <circle className="ring" cx="74" cy="36" r="4" />
      <circle className="ring ring--pulse" cx="74" cy="36" r="4" />
      <circle className="dot dot--c" cx="74" cy="36" r="1.8" />
      {/* the way back, dashed */}
      <path className="ln ln--soft" d="M56,46 C48,52 34,52 26,44" />
    </svg>
  )
}
