/* The drawings on the work cards, in the hand of the products' figures (the
   drop card's `DropDrawing`, the dialog and stat drawings of the tool
   template): ink at low opacity, a box filled with a breath of paper, the
   ringed dot as the focal marker, and the accent used ONCE, on the one line
   that carries the meaning. Smaller and plainer than the drop card's, since
   a card is a line of text tall. Each drawing is literal:

   - agent: a figure at its desk — a head (the ringed dot, which breathes
     while the agent works) over a paper box with two lines of what it is
     writing; the accent line is the one it is on now.
   - shell: a terminal box — the prompt chevron and the line being typed,
     in accent, with the cursor dot at its end, breathing while it runs.

   Ink comes from the app's tokens (`.chat-drawing` in system.css), so every
   theme just works; the card's own rules size and animate it
   (`.work-drawing`). Words never go inside a drawing: the card says them
   beside. */

export function WorkDrawing({
  kind,
  working
}: {
  kind: 'agent' | 'shell'
  /** Breathing: the agent has acted lately, the command still runs. */
  working: boolean
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 48 40"
      className="chat-drawing work-drawing"
      data-kind={kind}
      data-working={working || undefined}
      aria-hidden="true"
    >
      {kind === 'agent' ? (
        <>
          {/* the paper on the desk, and the two lines on it */}
          <rect className="bx bx--front" x="10" y="18" width="28" height="18" rx="4" />
          <line className="ln ln--thin" x1="16" y1="25" x2="32" y2="25" />
          <line className="ln ln--c work-line" x1="16" y1="30" x2="26" y2="30" />
          {/* the head, over the desk: the ringed dot that breathes */}
          <circle className="ring" cx="24" cy="10" r="6" />
          <circle className="dot dot--c work-pulse" cx="24" cy="10" r="2.4" />
        </>
      ) : (
        <>
          {/* the terminal box, its prompt and the line being typed */}
          <rect className="bx bx--front" x="6" y="8" width="36" height="24" rx="4" />
          <path className="head" d="M12,15 L17,19 L12,23" />
          <line className="ln ln--c work-line" x1="21" y1="19" x2="31" y2="19" />
          <circle className="dot dot--c work-pulse" cx="34.5" cy="19" r="1.8" />
        </>
      )}
    </svg>
  )
}
