/* The drawing on the drop card, in the hand of the products' figures (the
   dialog and stat drawings of the tool template, Slideless, the ERP tools):
   ink at low opacity, boxes filled with a breath of paper, the ringed dot as
   the focal marker, and the accent used ONCE, on the one line that carries
   the meaning — here the line the thing being dragged travels along to land
   in the message. Each drawing is literal:

   - files: a page and a folder above the composer. The page leaves along the
     accent line and lands where the ringed dot waits, an attachment; the
     folder's own line, dashed, goes to the composer's text, since a folder
     lands as its path and never as a chip.
   - sessions: the sidebar's rows beside the composer; the one being dragged
     has come out of its column and travels the accent line into the message,
     the others stay seated.

   The accent line draws itself once as the card comes up; a reader who asked
   for no motion gets the still drawing. Ink comes from the app's tokens
   (`.chat-drawing` in system.css), so every theme just works. Words never go
   inside a drawing: the card says them underneath. */

export type DropDrawingKind = 'files' | 'sessions'

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
  className = ''
}: {
  x: number
  y: number
  className?: string
}): React.JSX.Element {
  const w = 46
  const h = 36
  const t = 16
  return (
    <g className={className}>
      <path
        className="bx"
        d={`M${x + 4},${y} H${x + t} l5,5 H${x + w - 4} a4,4 0 0 1 4,4 V${y + h - 4} a4,4 0 0 1 -4,4 H${x + 4} a4,4 0 0 1 -4,-4 V${y + 4} a4,4 0 0 1 4,-4 Z`}
      />
      <line className="ln ln--thin" x1={x} y1={y + 12} x2={x + w} y2={y + 12} />
    </g>
  )
}

export function DropDrawing({ kind }: { kind: DropDrawingKind }): React.JSX.Element {
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
          {/* the folder: its line goes to the composer's text, where its path lands */}
          <Folder x={136} y={24} className="fan fan--back" />
          <path className="ln ln--soft" d="M158,64 C158,80 156,96 150,112" />
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
