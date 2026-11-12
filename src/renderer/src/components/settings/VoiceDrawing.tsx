import type React from 'react'

/* The ElevenLabs card's figure (Settings → Integrations, PRDCT-4410), in the
   hand of the app's other drawings (the `.chat-drawing` rules: ink at low
   opacity, the page filled with paper, the ringed dot where the thing lands,
   the accent on the ONE line it travels along). Not the service's mark: a
   page of Folio, one of its lines being read, and the voice leaving the page
   from the end of that line as a wave, landing on the ringed dot where it is
   heard; two soft arcs carry it on.

   - `invite`: the card with no key, beside the field. The wave draws itself
     once as the card comes up and the landing pulses once.
   - `quiet`: the card once a key is set, beside the account: smaller, and
     still.

   A reader who asked for no motion gets the still drawing either way. Words
   never go inside it: the row says them beside. */
export function VoiceDrawing({ quiet = false }: { quiet?: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 120 72"
      className="chat-drawing voice-drawing"
      data-quiet={quiet ? 'true' : undefined}
      aria-hidden="true"
    >
      {/* the ground line */}
      <line className="ln ln--thin" x1="4" y1="66" x2="116" y2="66" />
      {/* the page behind, a breath off the one in front */}
      <rect className="bx" x="14" y="8" width="38" height="52" rx="4" />
      {/* the page, its lines; the second is the one being read */}
      <rect className="bx bx--front" x="8" y="12" width="38" height="52" rx="4" />
      <line className="ln" x1="15" y1="22" x2="36" y2="22" />
      <line className="ln" x1="15" y1="31" x2="31" y2="31" />
      <line className="ln ln--thin" x1="15" y1="40" x2="38" y2="40" />
      <line className="ln ln--thin" x1="15" y1="48" x2="33" y2="48" />
      <line className="ln ln--soft" x1="15" y1="56" x2="27" y2="56" />
      {/* the voice, from the end of the line being read, out of the page */}
      <path
        className={quiet ? 'ln ln--c' : 'ln ln--c travel'}
        pathLength={1}
        d="M33,31 C38,31 40,23 45,23 S52,39 58,39 S65,25 71,25 S78,35 83,35 S88,31 91,31"
      />
      {/* where it is heard, and the arcs that carry it on */}
      <circle className="bx bx--front" cx="98" cy="31" r="7" />
      <circle className="ring" cx="98" cy="31" r="7" />
      {!quiet && <circle className="ring ring--pulse" cx="98" cy="31" r="7" />}
      <circle className="dot dot--c" cx="98" cy="31" r="2.8" />
      <path className="ln ln--thin" d="M109,22 C112.5,27 112.5,35 109,40" />
      <path className="ln ln--soft" d="M114.5,17 C119.5,25 119.5,37 114.5,45" />
    </svg>
  )
}

/** The Preview button's glyph while the voice's sample plays: three of the
 *  spine's ticks breathing in turn, the middle one in the accent. Still for
 *  a reader who asked for no motion. */
export function PlayingGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" className="chat-drawing playing-glyph" aria-hidden="true">
      <line className="ln" x1="3" y1="4" x2="3" y2="8" />
      <line className="ln ln--c" x1="6" y1="2" x2="6" y2="10" />
      <line className="ln" x1="9" y1="4" x2="9" y2="8" />
    </svg>
  )
}
