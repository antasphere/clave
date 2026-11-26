import type React from 'react'

/* The Jev card's figure (Settings → Integrations, PRDCT-5179), in the hand of
   `VoiceDrawing` beside it (the `.chat-drawing` rules: ink at low opacity,
   paper where something is held, the ringed dot where the thing lands, the
   accent on the ONE line it travels along). Not the service's mark: one line
   comes to a fork, the branch not taken stays a soft dashed line, and the
   branch taken carries the accent to the ringed dot that marks it.

   - `invite`: the card with no key, beside the field. The branch taken draws
     itself once as the card comes up and its landing pulses once.
   - `quiet`: the card once a key is set, beside its row: smaller, and still.

   A reader who asked for no motion gets the still drawing either way. Words
   never go inside it: the row says them beside. */
export function DecisionDrawing({ quiet = false }: { quiet?: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 120 72"
      className="chat-drawing decision-drawing"
      data-quiet={quiet ? 'true' : undefined}
      aria-hidden="true"
    >
      {/* the ground line */}
      <line className="ln ln--thin" x1="4" y1="66" x2="116" y2="66" />
      {/* the line that comes to the fork */}
      <line className="ln" x1="8" y1="38" x2="46" y2="38" />
      {/* the fork, a breath of paper where the choice is made */}
      <circle className="bx bx--front" cx="50" cy="38" r="4" />
      {/* the branch not taken, downwards, waiting */}
      <path className="ln ln--soft" d="M54,40 C64,46 70,52 84,52 S100,52 108,52" />
      <circle className="dot dot--seat" cx="108" cy="52" r="1.8" />
      {/* the branch taken, upwards, to where it lands */}
      <path
        className={quiet ? 'ln ln--c' : 'ln ln--c travel'}
        pathLength={1}
        d="M54,36 C64,30 70,22 82,22 S88,22 91,22"
      />
      <circle className="bx bx--front" cx="98" cy="22" r="7" />
      <circle className="ring" cx="98" cy="22" r="7" />
      {!quiet && <circle className="ring ring--pulse" cx="98" cy="22" r="7" />}
      <circle className="dot dot--c" cx="98" cy="22" r="2.8" />
    </svg>
  )
}
