/* The first-run walk's drawing, in the hand of the products' figures (the
   tool template's DialogDrawing, Clave's DropDrawing): ink at low opacity,
   boxes filled with a breath of paper, the ringed dot as the focal marker,
   the accent used ONCE, on the line that carries the meaning — here, how far
   round the walk has gone.

   The ring is the walk itself, one seat per step on its divisions. The
   accent is one fixed circle revealed by its dash offset, measured in the
   ring's real length, so each step advances it by exactly one division and
   it always stops on a seat; a seat lights when the accent arrives. In the
   middle, a small scene per step: the window (what Clave is), a light page
   and a dark one (the look), two ends
   joined (connecting an agent), a conversation (the chat you prefer), the
   folder with a session open on it (your workspace). When the ring
   closes, the space gathers itself and lets go, a wash of the accent behind
   it, and the agent's tile blooms where it was (`Onboarding.tsx`).

   Words never go inside a drawing: the aside says them underneath. Ink comes
   from the app's tokens (`.onb-drawing` in onboarding.css), so every theme
   just works; a reader who asked for no motion gets the still drawing. */

const C = { x: 120, y: 126, r: 84 }

function polar(angle: number, radius: number): { x: number; y: number } {
  return {
    x: C.x + radius * Math.cos(((angle - 90) * Math.PI) / 180),
    y: C.y + radius * Math.sin(((angle - 90) * Math.PI) / 180)
  }
}

/** A circle drawn from the top, clockwise, as two half arcs. */
const RING = `M${C.x},${C.y - C.r} A${C.r},${C.r} 0 0 1 ${C.x},${C.y + C.r} A${C.r},${C.r} 0 0 1 ${C.x},${C.y - C.r}`
const LENGTH = 2 * Math.PI * C.r

/** Step 1: the window — a frame, its sidebar of rows, a conversation. */
function WindowScene(): React.JSX.Element {
  return (
    <g className="onb-scene">
      <rect className="bx bx--front" x="88" y="102" width="64" height="48" rx="7" />
      <line className="ln ln--thin" x1="108" y1="102" x2="108" y2="150" />
      <circle className="dot dot--seat" cx="98" cy="114" r="2.2" />
      <circle className="dot dot--seat" cx="98" cy="124" r="2.2" />
      <circle className="dot" cx="98" cy="134" r="2.2" />
      <line className="ln ln--thin" x1="115" y1="114" x2="142" y2="114" />
      <line className="ln ln--thin" x1="115" y1="122" x2="134" y2="122" />
      <rect className="bx" x="115" y="132" width="30" height="10" rx="4" />
    </g>
  )
}

/** Step 2: the look — a light page and a dark one, half over each other. */
function LookScene(): React.JSX.Element {
  return (
    <g className="onb-scene">
      <rect className="bx bx--front" x="90" y="104" width="40" height="34" rx="6" />
      <line className="ln ln--thin" x1="97" y1="114" x2="117" y2="114" />
      <line className="ln ln--thin" x1="97" y1="121" x2="111" y2="121" />
      <g className="onb-scene-row" style={{ animationDelay: '160ms' }}>
        <rect className="onb-scene-dark" x="110" y="114" width="40" height="34" rx="6" />
        <line className="onb-scene-dark-ink" x1="117" y1="124" x2="137" y2="124" />
        <line className="onb-scene-dark-ink" x1="117" y1="131" x2="131" y2="131" />
      </g>
    </g>
  )
}

/** Step 3: two ends, the app and the agent, joined. */
function ConnectScene(): React.JSX.Element {
  return (
    <g className="onb-scene">
      <rect className="bx bx--front" x="86" y="114" width="24" height="24" rx="6" />
      <rect className="bx bx--front" x="130" y="114" width="24" height="24" rx="6" />
      <path className="ln ln--soft onb-scene-link" d="M110,126 L130,126" />
      <circle className="dot" cx="98" cy="126" r="2.6" />
      <circle className="dot" cx="142" cy="126" r="2.6" />
    </g>
  )
}

/** Step 4: a conversation, two turns, the second one being written. */
function ChatScene(): React.JSX.Element {
  return (
    <g className="onb-scene">
      <g className="onb-scene-row" style={{ animationDelay: '120ms' }}>
        <rect className="bx bx--front" x="112" y="104" width="38" height="13" rx="6" />
        <line className="ln ln--thin" x1="119" y1="110.5" x2="142" y2="110.5" />
      </g>
      <g className="onb-scene-row" style={{ animationDelay: '260ms' }}>
        <line className="ln ln--thin" x1="90" y1="126" x2="136" y2="126" />
        <line className="ln ln--thin" x1="90" y1="134" x2="126" y2="134" />
        <line className="ln ln--thin" x1="90" y1="142" x2="112" y2="142" />
        <circle className="dot onb-scene-caret" cx="117" cy="142" r="2" />
      </g>
    </g>
  )
}

/** Step 5: the folder the workspace lives in, a session already open on it. */
function FolderScene(): React.JSX.Element {
  return (
    <g className="onb-scene">
      <path
        className="bx bx--front"
        d="M92,108 H106 l5,5 H144 a4,4 0 0 1 4,4 V140 a4,4 0 0 1 -4,4 H96 a4,4 0 0 1 -4,-4 V112 a4,4 0 0 1 4,-4 Z"
      />
      <line className="ln ln--thin" x1="92" y1="120" x2="148" y2="120" />
      <g className="onb-scene-row" style={{ animationDelay: '200ms' }}>
        <rect className="bx" x="100" y="126" width="40" height="11" rx="4" />
        <circle className="dot" cx="107" cy="131.5" r="2" />
        <line className="ln ln--thin" x1="113" y1="131.5" x2="132" y2="131.5" />
      </g>
    </g>
  )
}

export function OnboardingDrawing({
  steps,
  done
}: {
  /** How many steps the walk has: one seat each on the ring. */
  steps: number
  /** How many are behind the reader: 0 on the first, `steps` once over. */
  done: number
}): React.JSX.Element {
  const reached = Math.max(0, Math.min(done, steps))
  const closed = reached >= steps
  const offset = LENGTH * (1 - reached / steps)
  const seats = Array.from({ length: steps }, (_, i) => {
    const angle = (360 / steps) * i
    return { ...polar(angle, C.r), inner: polar(angle, 50), stop: polar(angle, C.r - 14) }
  })
  return (
    <svg viewBox="0 0 240 244" className="onb-drawing" aria-hidden="true">
      <defs>
        <radialGradient id="onb-wash">
          <stop offset="0%" className="wash-stop wash-stop--in" />
          <stop offset="100%" className="wash-stop wash-stop--out" />
        </radialGradient>
      </defs>
      <circle
        className={closed ? 'wash wash--go' : 'wash'}
        cx={C.x}
        cy={C.y}
        r={C.r}
        fill="url(#onb-wash)"
      />
      <g className={closed ? 'space space--closed' : 'space'}>
        <line className="ln ln--thin" x1="10" y1="236" x2="230" y2="236" />
        <circle className="ring" cx={C.x} cy={C.y} r={C.r} />
        <circle className="ln ln--soft" cx={C.x} cy={C.y} r="46" />
        {/* how far the walk has gone, under the seats so its tip ends behind one */}
        <path
          className="ln ln--c travel"
          d={RING}
          strokeDasharray={`${LENGTH} ${LENGTH}`}
          strokeDashoffset={offset}
        />
        {seats.map((seat, i) => (
          <g key={i}>
            <path
              className="ln ln--thin"
              d={`M${seat.inner.x},${seat.inner.y} L${seat.stop.x},${seat.stop.y}`}
            />
            <circle className="bx bx--front" cx={seat.x} cy={seat.y} r="12" />
            <circle
              className={i > reached ? 'dot seat-dot dot--ahead' : 'dot seat-dot'}
              cx={seat.x}
              cy={seat.y}
              r="4"
            />
          </g>
        ))}
        {/* the centre: one scene per step, the next one coming in as the last goes */}
        <circle className="bx bx--front" cx={C.x} cy={C.y} r="40" />
        {reached === 0 && <WindowScene key="window" />}
        {reached === 1 && <LookScene key="look" />}
        {reached === 2 && <ConnectScene key="connect" />}
        {reached === 3 && <ChatScene key="chat" />}
        {reached >= 4 && <FolderScene key="folder" />}
      </g>
    </svg>
  )
}
