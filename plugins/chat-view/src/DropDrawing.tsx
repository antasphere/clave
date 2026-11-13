/* The drawing on the drop card, in the hand of the products' figures (the
   dialog and stat drawings of the tool template, Slideless, the ERP tools):
   ink at low opacity, boxes filled with a breath of paper, the ringed dot as
   the focal marker, and the accent used ONCE, on the one line that carries
   the meaning — here the line the thing being dragged travels along to land
   in the message. Each drawing is literal:

   - files: a page and a folder above the composer. The page leaves along the
     accent line and lands where the ringed dot waits; the folder is owed a
     line of its own to the same place, dashed until it has one.
   - sessions: the sidebar's rows beside the composer; the one being dragged
     has come out of its column and travels the accent line into the message,
     the others stay seated.
   - refused: the refusal card's, smaller and drawn beside its words rather
     than over them (PRDCT-4329). This Mac on the left, a laptop with the
     folder on its screen; the server on the right, its stacked units. The
     accent line leaves the folder for the server and stops short against
     its bar; the way on is only dashed, to the ringed dot where it would
     have landed, which stays ink: nothing arrived.

   The accent line draws itself once as the card comes up; a reader who asked
   for no motion gets the still drawing. Ink comes from the app's tokens
   (`.chat-drawing` in system.css), so every theme just works. Words never go
   inside a drawing: the card says them underneath. */

export type DropDrawingKind = 'files' | 'sessions' | 'refused'

/** The composer, as every drawing shows it: a paper box with one line of
 *  text and the send dot at its end. */
function Composer({ x, y, w }: { x: number; y: number; w: number }): React.JSX.Element {
  return (
    <g>
      <rect className="bx bx--front" x={x} y={y} width={w} height="30" rx="9" />
      <line className="ln ln--thin" x1={x + 14} y1={y + 15} x2={x + w - 40} y2={y + 15} />
      <circle className="dot" cx={x + w - 15} cy={y + 15} r="4" />
    </g>
  )
}

/** A page: a box with its corner folded, the fold drawn as the thin line. */
function Page({
  x,
  y,
  front,
  className = ''
}: {
  x: number
  y: number
  front?: boolean
  className?: string
}): React.JSX.Element {
  const w = 40
  const h = 50
  const f = 11
  return (
    <g className={className}>
      <path
        className={front ? 'bx bx--front' : 'bx'}
        d={`M${x + 4},${y} H${x + w - f} L${x + w},${y + f} V${y + h - 4} a4,4 0 0 1 -4,4 H${x + 4} a4,4 0 0 1 -4,-4 V${y + 4} a4,4 0 0 1 4,-4 Z`}
      />
      <path className="ln ln--thin" d={`M${x + w - f},${y} V${y + f} H${x + w}`} />
      <line className="ln ln--thin" x1={x + 9} y1={y + 24} x2={x + w - 9} y2={y + 24} />
      <line className="ln ln--thin" x1={x + 9} y1={y + 33} x2={x + w - 14} y2={y + 33} />
    </g>
  )
}

/** A folder: a box with its tab, the tab's edge drawn as the thin line. */
function Folder({
  x,
  y,
  scale = 1,
  front,
  className = ''
}: {
  x: number
  y: number
  /** Smaller for the refusal card's drawing; the strokes keep their weight. */
  scale?: number
  front?: boolean
  className?: string
}): React.JSX.Element {
  const w = 46 * scale
  const h = 36 * scale
  const t = 16 * scale
  return (
    <g className={className}>
      <path
        className={front ? 'bx bx--front' : 'bx'}
        d={`M${x + 4},${y} H${x + t} l${5 * scale},${5 * scale} H${x + w - 4} a4,4 0 0 1 4,4 V${y + h - 4} a4,4 0 0 1 -4,4 H${x + 4} a4,4 0 0 1 -4,-4 V${y + 4} a4,4 0 0 1 4,-4 Z`}
      />
      <line className="ln ln--thin" x1={x} y1={y + 12 * scale} x2={x + w} y2={y + 12 * scale} />
    </g>
  )
}

/** The refusal card's drawing: the folder on this Mac, the server, and the
 *  line between them that does not arrive. */
function Refused(): React.JSX.Element {
  return (
    <svg viewBox="0 0 132 80" className="chat-drawing drop-refused-drawing" aria-hidden="true">
      {/* the ground both machines stand on */}
      <line className="ln ln--thin" x1="4" y1="74" x2="128" y2="74" />
      {/* this Mac: a laptop, the folder on its screen */}
      <rect className="bx" x="6" y="28" width="48" height="34" rx="4" />
      <rect className="bx bx--front" x="1" y="62" width="58" height="5" rx="2.5" />
      <Folder x={17} y={36} scale={0.58} front />
      {/* the server: three units, each with its slot and its light, the top
          one's light the ringed dot below, where the line would have landed */}
      <rect className="bx bx--front" x="94" y="22" width="34" height="15" rx="3.5" />
      <line className="ln ln--thin" x1="104" y1="29.5" x2="121" y2="29.5" />
      <rect className="bx" x="94" y="40" width="34" height="15" rx="3.5" />
      <circle className="dot dot--seat" cx="101" cy="47.5" r="1.6" />
      <line className="ln ln--thin" x1="107" y1="47.5" x2="121" y2="47.5" />
      <rect className="bx" x="94" y="58" width="34" height="15" rx="3.5" />
      <circle className="dot dot--seat" cx="101" cy="65.5" r="1.6" />
      <line className="ln ln--thin" x1="107" y1="65.5" x2="121" y2="65.5" />
      {/* the one line that carries the meaning: it leaves the folder for the
          server and stops short, against its bar */}
      <path
        className="ln ln--c travel"
        pathLength={1}
        d="M38,40 C44,22 56,13 68,13 M72,7.5 V18.5"
      />
      {/* where it would have gone, only dashed, and where it would have landed */}
      <path className="ln ln--soft" d="M77,13 C83,13 88,17 90.5,23" />
      <circle className="bx bx--front" cx="94" cy="29.5" r="4.5" />
      <circle className="ring" cx="94" cy="29.5" r="4.5" />
      <circle className="dot dot--seat" cx="94" cy="29.5" r="1.8" />
    </svg>
  )
}

export function DropDrawing({ kind }: { kind: DropDrawingKind }): React.JSX.Element {
  if (kind === 'refused') return <Refused />
  return (
    <svg viewBox="0 0 240 150" className="chat-drawing" aria-hidden="true">
      <defs>
        <marker
          id="chat-drawing-head"
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
      {kind === 'files' ? (
        <>
          {/* the ground line the composer sits on */}
          <line className="ln ln--thin" x1="18" y1="138" x2="222" y2="138" />
          <Composer x={46} y={100} w={148} />
          {/* the folder: present, owed a line of its own to the landing */}
          <Folder x={136} y={24} className="fan fan--back" />
          <path className="ln ln--soft" d="M158,64 C158,82 150,98 134,108" />
          {/* the front page, and the one line that carries it into the message */}
          <Page x={78} y={22} front className="fan fan--front" />
          <path
            className="ln ln--c travel"
            pathLength={1}
            d="M98,76 C98,88 104,96 112,104"
            markerEnd="url(#chat-drawing-head)"
          />
          {/* where it lands */}
          <circle className="bx bx--front" cx="120" cy="115" r="9" />
          <circle className="ring" cx="120" cy="115" r="9" />
          <circle className="ring ring--pulse" cx="120" cy="115" r="9" />
          <circle className="dot dot--c" cx="120" cy="115" r="3.5" />
        </>
      ) : (
        <>
          {/* the sidebar: a column of rows, each with its mark */}
          <line className="ln ln--thin" x1="18" y1="20" x2="18" y2="134" />
          <rect className="bx" x="26" y="26" width="64" height="20" rx="6" />
          <circle className="dot dot--seat" cx="38" cy="36" r="3" />
          <line className="ln ln--thin" x1="48" y1="36" x2="78" y2="36" />
          <rect className="bx" x="26" y="106" width="64" height="20" rx="6" />
          <circle className="dot dot--seat" cx="38" cy="116" r="3" />
          <line className="ln ln--thin" x1="48" y1="116" x2="74" y2="116" />
          {/* its empty seat, dashed: the row has left it */}
          <rect className="ln ln--soft" x="26" y="66" width="64" height="20" rx="6" />
          {/* the row on its way, in front of everything */}
          <g className="lift">
            <rect className="bx bx--front" x="62" y="58" width="64" height="20" rx="6" />
            <circle className="dot" cx="74" cy="68" r="3" />
            <line className="ln ln--thin" x1="84" y1="68" x2="114" y2="68" />
          </g>
          {/* the composer it goes into */}
          <Composer x={132} y={90} w={90} />
          <path
            className="ln ln--c travel"
            pathLength={1}
            d="M128,68 C146,68 156,76 162,92"
            markerEnd="url(#chat-drawing-head)"
          />
          <circle className="bx bx--front" cx="168" cy="105" r="9" />
          <circle className="ring" cx="168" cy="105" r="9" />
          <circle className="ring ring--pulse" cx="168" cy="105" r="9" />
          <circle className="dot dot--c" cx="168" cy="105" r="3.5" />
        </>
      )}
    </svg>
  )
}
