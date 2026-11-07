/* The drawing beside a link the agent asks the reader to open and come back
   from (`clave_request_input`, kind `link`), in the hand of the chat's figures
   (`DropDrawing`, `ExchangeDrawing`, the `.chat-drawing` rules): ink at low
   opacity, paper boxes, the ringed dot as the focal marker, the accent used
   ONCE, on the line that carries the meaning. Literal: the card on the left
   with its one line, a browser window on the right with its title bar; the
   accent line leaves the card and lands on the window's ringed dot, where the
   reader signs in; the way back, dashed, under them. The line draws itself
   once as the card comes up; a reader who asked for no motion gets the still
   drawing. Words never go inside a drawing: the card says them beside. */

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
