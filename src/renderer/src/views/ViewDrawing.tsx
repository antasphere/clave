/* The small drawings on the session menu's view tiles, in the hand of the chat
   view's drop and empty drawings (`.chat-drawing` in system.css: ink at low
   opacity, boxes on a breath of paper, the ringed dot as the focal marker).
   Each one is literal, so the reader picks a view by what it looks like rather
   than by a name they have to remember:

   - chat: a message from the reader on the right, the answer's lines on the
     left, the composer at the foot with its send dot.
   - terminal (Enclave): a frame with the prompt's chevron, the output's lines
     and the block cursor.
   - folio: one sheet of paper, a heading and its paragraph.
   - report (a routine run): a frame with a chart's bars.
   - any other view (a plugin's page): a frame with two lines.

   The accent goes on ONE mark, and only in the tile of the view on screen: the
   send dot, the cursor, the folio's marker, the tallest bar. Words never go
   inside a drawing; the tile says the view's name underneath. */

type ViewDrawingKind = 'chat' | 'terminal' | 'folio' | 'report' | 'page'

/** Which drawing a view id gets: the bundled views by their id, anything a
 *  plugin contributes as a page. */
function drawingKind(viewId: string): ViewDrawingKind {
  if (viewId === 'clave.chat-view/chat') return 'chat'
  if (viewId === 'clave.chat-view/terminal') return 'terminal'
  if (viewId === 'clave.chat-view/lab') return 'folio'
  if (viewId === 'clave.routine-report/report') return 'report'
  return 'page'
}

export function ViewDrawing({
  viewId,
  active
}: {
  viewId: string
  active: boolean
}): React.JSX.Element {
  const kind = drawingKind(viewId)
  const mark = active ? 'dot dot--c' : 'dot'
  return (
    <svg viewBox="0 0 72 44" className="chat-drawing view-drawing" aria-hidden="true">
      {kind === 'chat' && (
        <>
          <rect className="bx bx--front" x="34" y="5" width="31" height="11" rx="5.5" />
          <line className="ln ln--thin" x1="40" y1="10.5" x2="58" y2="10.5" />
          <line className="ln ln--thin" x1="8" y1="21" x2="50" y2="21" />
          <line className="ln ln--thin" x1="8" y1="26" x2="40" y2="26" />
          <rect className="bx bx--front" x="6" y="32" width="60" height="9" rx="4.5" />
          <line className="ln ln--thin" x1="11" y1="36.5" x2="34" y2="36.5" />
          <circle className={mark} cx="60.5" cy="36.5" r="2" />
        </>
      )}
      {kind === 'terminal' && (
        <>
          <rect className="bx bx--front" x="6" y="4" width="60" height="36" rx="4" />
          <path className="ln" d="M12,11 L15.5,14 L12,17" />
          <line className="ln ln--thin" x1="19" y1="14" x2="44" y2="14" />
          <line className="ln ln--thin" x1="12" y1="22" x2="54" y2="22" />
          <line className="ln ln--thin" x1="12" y1="27" x2="38" y2="27" />
          <rect className={mark} x="12" y="31.5" width="4" height="5" rx="0.5" />
        </>
      )}
      {kind === 'folio' && (
        <>
          <rect className="bx" x="23" y="5" width="30" height="36" rx="2.5" />
          <rect className="bx bx--front" x="19" y="3" width="30" height="36" rx="2.5" />
          <line className="ln" x1="24" y1="10.5" x2="38" y2="10.5" />
          <line className="ln ln--thin" x1="24" y1="17" x2="44" y2="17" />
          <line className="ln ln--thin" x1="24" y1="21.5" x2="43" y2="21.5" />
          <line className="ln ln--thin" x1="24" y1="26" x2="40" y2="26" />
          <circle className={mark} cx="25.5" cy="33" r="1.8" />
        </>
      )}
      {kind === 'report' && (
        <>
          <rect className="bx bx--front" x="6" y="4" width="60" height="36" rx="4" />
          <line className="ln ln--thin" x1="12" y1="34" x2="60" y2="34" />
          <rect className="bx" x="16" y="24" width="6" height="10" rx="1" />
          <rect className="bx" x="27" y="18" width="6" height="16" rx="1" />
          <rect className={mark} x="38" y="11" width="6" height="23" rx="1" />
          <rect className="bx" x="49" y="21" width="6" height="13" rx="1" />
        </>
      )}
      {kind === 'page' && (
        <>
          <rect className="bx bx--front" x="6" y="4" width="60" height="36" rx="4" />
          <line className="ln ln--thin" x1="6" y1="11" x2="66" y2="11" />
          <circle className={mark} cx="11" cy="7.5" r="1.3" />
          <line className="ln ln--thin" x1="12" y1="19" x2="50" y2="19" />
          <line className="ln ln--thin" x1="12" y1="24" x2="42" y2="24" />
        </>
      )}
    </svg>
  )
}
