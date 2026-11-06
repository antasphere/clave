/* The drawing on the panel's empty state, in the hand of the chat's drop
   card (`DropDrawing`): ink at low opacity, boxes filled with a breath of
   paper, the ringed dot as the focal marker, the accent used ONCE on the one
   line that carries the meaning. Literal: a clock, the schedule; a page with
   its rows, the deck the run will fill; the accent line leaves the clock's
   hand and lands where the ringed dot waits on the page. The line draws
   itself once as the panel opens; a reader who asked for no motion gets the
   still drawing. Ink comes from `.chat-drawing` (system.css), so every theme
   just works. Words never go inside a drawing: the state says them below. */
export function RoutineDrawing(): React.JSX.Element {
  return (
    <svg viewBox="0 0 240 150" className="chat-drawing" aria-hidden="true">
      <defs>
        <marker
          id="routine-drawing-head"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path className="head head--c" d="M1.5,1.5 L8,5 L1.5,8.5" />
        </marker>
      </defs>
      {/* the ground line the page sits on */}
      <line className="ln ln--thin" x1="18" y1="132" x2="222" y2="132" />
      {/* the clock: the schedule, its hour hand still */}
      <circle className="bx" cx="64" cy="72" r="32" />
      <line className="ln ln--thin" x1="64" y1="44" x2="64" y2="49" />
      <line className="ln ln--thin" x1="92" y1="72" x2="87" y2="72" />
      <line className="ln ln--thin" x1="64" y1="100" x2="64" y2="95" />
      <line className="ln ln--thin" x1="36" y1="72" x2="41" y2="72" />
      <line className="ln" x1="64" y1="72" x2="52" y2="84" />
      <circle className="dot" cx="64" cy="72" r="2.5" />
      {/* the page: the deck the run fills, a headline and two rows */}
      <rect className="bx bx--front" x="146" y="46" width="76" height="86" rx="7" />
      <line className="ln" x1="158" y1="64" x2="200" y2="64" />
      <circle className="dot dot--seat" cx="161" cy="82" r="3" />
      <line className="ln ln--thin" x1="170" y1="82" x2="208" y2="82" />
      <circle className="dot dot--seat" cx="161" cy="98" r="3" />
      <line className="ln ln--thin" x1="170" y1="98" x2="202" y2="98" />
      <circle className="dot dot--seat" cx="161" cy="114" r="3" />
      <line className="ln ln--thin" x1="170" y1="114" x2="196" y2="114" />
      {/* the minute hand leaves the clock and carries the run to the page */}
      <path
        className="ln ln--c travel"
        pathLength={1}
        d="M64,72 L86,56 C108,40 128,40 142,50"
        markerEnd="url(#routine-drawing-head)"
      />
      {/* where it lands */}
      <circle className="bx bx--front" cx="150" cy="54" r="9" />
      <circle className="ring" cx="150" cy="54" r="9" />
      <circle className="ring ring--pulse" cx="150" cy="54" r="9" />
      <circle className="dot dot--c" cx="150" cy="54" r="3.5" />
    </svg>
  )
}

/* The discussion opening: the report's page on the left, a speech bubble on
   the right, and the accent line carrying the run's conversation from the
   page into the bubble, where the ringed dot waits. Same hand and same rules
   as the drawing above. */
export function DiscussionDrawing(): React.JSX.Element {
  return (
    <svg viewBox="0 0 240 150" className="chat-drawing" aria-hidden="true">
      <defs>
        <marker
          id="routine-discussion-head"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path className="head head--c" d="M1.5,1.5 L8,5 L1.5,8.5" />
        </marker>
      </defs>
      <line className="ln ln--thin" x1="18" y1="132" x2="222" y2="132" />
      {/* the report the conversation comes from */}
      <rect className="bx" x="24" y="38" width="66" height="80" rx="7" />
      <line className="ln" x1="35" y1="54" x2="72" y2="54" />
      <circle className="dot dot--seat" cx="38" cy="72" r="3" />
      <line className="ln ln--thin" x1="46" y1="72" x2="78" y2="72" />
      <circle className="dot dot--seat" cx="38" cy="88" r="3" />
      <line className="ln ln--thin" x1="46" y1="88" x2="74" y2="88" />
      {/* the conversation: a bubble with its tail, two lines of text */}
      <path
        className="bx bx--front"
        d="M142,40 H206 a8,8 0 0 1 8,8 V86 a8,8 0 0 1 -8,8 H168 l-12,12 v-12 H142 a8,8 0 0 1 -8,-8 V48 a8,8 0 0 1 8,-8 Z"
      />
      <line className="ln ln--thin" x1="148" y1="58" x2="200" y2="58" />
      <line className="ln ln--thin" x1="148" y1="72" x2="186" y2="72" />
      {/* the run's conversation carried over */}
      <path
        className="ln ln--c travel"
        pathLength={1}
        d="M90,80 C104,80 112,76 124,72"
        markerEnd="url(#routine-discussion-head)"
      />
      <circle className="bx bx--front" cx="132" cy="70" r="9" />
      <circle className="ring" cx="132" cy="70" r="9" />
      <circle className="ring ring--pulse" cx="132" cy="70" r="9" />
      <circle className="dot dot--c" cx="132" cy="70" r="3.5" />
    </svg>
  )
}
