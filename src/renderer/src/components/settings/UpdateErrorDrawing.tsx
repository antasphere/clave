import type React from 'react'
import type { UpdaterErrorCause } from '../../../../shared/updater-errors'
import './update-error.css'

/* A failed check or download, drawn in the hand of the app's other figures
   (the first-run walk, the chat's empty states): ink at low opacity, paper
   boxes, the ringed dot as the focal marker, the accent used ONCE, on the
   place the link broke. This Mac on the left, GitHub's release server on the
   right, the line between them; where the ring sits is the cause:

   - server:   the line reaches almost all the way, GitHub's side is faded
   - network:  the line stops at this Mac
   - manifest: the line arrives, and the page it came for is missing
   - refused:  a gate across the line, halfway
   - local:    the line arrives, and the ring sits on this Mac
   - unknown:  the line breaks in the middle

   Words never go inside a drawing: the callout says them beside it. A reader
   who asked for no motion gets the still drawing. */

const LINK_Y = 40
const MAC_RIGHT = 66
const SERVER_LEFT = 136

function Ring({ x, y }: { x: number; y: number }): React.JSX.Element {
  return (
    <g>
      <circle className="bx bx--front" cx={x} cy={y} r="6" />
      <circle className="ring" cx={x} cy={y} r="6" />
      <circle className="ring ring--pulse" cx={x} cy={y} r="6" />
      <circle className="dot dot--c" cx={x} cy={y} r="2.4" />
    </g>
  )
}

function Mac(): React.JSX.Element {
  return (
    <g>
      <rect className="bx bx--front" x="10" y="18" width="56" height="40" rx="6" />
      <line className="ln ln--thin" x1="10" y1="27" x2="66" y2="27" />
      {[16, 21, 26].map((x) => (
        <circle key={x} className="dot dot--seat" cx={x} cy="22.5" r="1.3" />
      ))}
      <line className="ln" x1="18" y1="37" x2="50" y2="37" />
      <line className="ln ln--soft" x1="18" y1="46" x2="42" y2="46" />
      <line className="ln ln--thin" x1="38" y1="58" x2="38" y2="66" />
      <line className="ln ln--thin" x1="28" y1="66" x2="48" y2="66" />
    </g>
  )
}

function Server({ faded }: { faded: boolean }): React.JSX.Element {
  return (
    <g className={faded ? 'upd-faded' : undefined}>
      {[14, 33, 52].map((y) => (
        <g key={y}>
          <rect className="bx" x={SERVER_LEFT} y={y} width="52" height="14" rx="4" />
          <circle className="dot dot--seat" cx={SERVER_LEFT + 8} cy={y + 7} r="1.6" />
          <line
            className="ln ln--thin"
            x1={SERVER_LEFT + 16}
            y1={y + 7}
            x2={SERVER_LEFT + 42}
            y2={y + 7}
          />
        </g>
      ))}
    </g>
  )
}

/** The line from this Mac towards the server, solid up to `to`, then waiting. */
function Link({ to, rest = true }: { to: number; rest?: boolean }): React.JSX.Element {
  return (
    <g>
      <path className="ln travel" d={`M${MAC_RIGHT},${LINK_Y} H${to}`} />
      {rest && to < SERVER_LEFT && (
        <line className="ln ln--soft" x1={to + 10} y1={LINK_Y} x2={SERVER_LEFT} y2={LINK_Y} />
      )}
    </g>
  )
}

export function UpdateErrorDrawing({ cause }: { cause: UpdaterErrorCause }): React.JSX.Element {
  return (
    <svg viewBox="0 0 200 76" className="upd-drawing" data-cause={cause} aria-hidden="true">
      <Mac />
      <Server faded={cause === 'server'} />
      {cause === 'server' && (
        <>
          <Link to={116} rest={false} />
          <Ring x={124} y={LINK_Y} />
        </>
      )}
      {cause === 'network' && (
        <>
          <Ring x={76} y={LINK_Y} />
          <line className="ln ln--soft" x1={86} y1={LINK_Y} x2={SERVER_LEFT} y2={LINK_Y} />
        </>
      )}
      {cause === 'manifest' && (
        <>
          <Link to={SERVER_LEFT} />
          {/* the page it came for, not there */}
          <rect className="ln ln--soft" x="108" y="4" width="18" height="22" rx="3" />
          <Ring x={117} y={15} />
        </>
      )}
      {cause === 'refused' && (
        <>
          <Link to={94} />
          <line className="ln" x1="101" y1={LINK_Y - 10} x2="101" y2={LINK_Y + 10} />
          <Ring x={101} y={LINK_Y - 16} />
        </>
      )}
      {cause === 'local' && (
        <>
          <Link to={SERVER_LEFT} />
          <Ring x={38} y={41} />
        </>
      )}
      {cause === 'unknown' && (
        <>
          <Link to={94} />
          <Ring x={101} y={LINK_Y} />
        </>
      )}
    </svg>
  )
}
