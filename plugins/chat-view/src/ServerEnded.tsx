import { useState } from 'react'
import type React from 'react'
import { ownerOf } from '../../../src/renderer/src/lib/fleet-identity'
import { useFleetStore } from '../../../src/renderer/src/store/fleet-store'
import { restartSessionProcess } from '../../../src/renderer/src/lib/switch-account'
import './empty.css'

/* A chat on a Clave server whose process ended there (PRDCT-4191): the
   server restarted, or stopped the chat. Drawn in the hand of the empty
   state (`EmptyDrawing`, the `.chat-drawing` rules): the conversation on
   the left, its last lines ruled; the server on the right, a tall paper box
   with its slots; the link between them a soft dashed line, broken where
   the connection was; the accent ONCE, on the server's light, the place the
   conversation comes back from. Words never go inside a drawing: the state
   says them underneath, with the way on, Resume, as one sentence. */

function ServerEndedDrawing(): React.JSX.Element {
  return (
    <svg viewBox="0 0 240 150" className="chat-drawing view-empty-drawing" aria-hidden="true">
      <line className="ln ln--thin" x1="18" y1="138" x2="222" y2="138" />
      {/* the conversation, its last lines ruled and still */}
      <rect className="bx bx--front" x="28" y="22" width="78" height="22" rx="11" />
      <line className="ln" x1="42" y1="33" x2="88" y2="33" />
      <line className="ln ln--soft" x1="28" y1="64" x2="112" y2="64" />
      <line className="ln ln--soft" x1="28" y1="76" x2="96" y2="76" />
      <line className="ln ln--soft" x1="28" y1="88" x2="104" y2="88" />
      {/* the link to the server, broken where the connection was */}
      <line className="ln ln--soft" x1="118" y1="76" x2="140" y2="76" />
      <line className="ln ln--soft" x1="156" y1="76" x2="172" y2="76" />
      {/* the server: a tall box with its slots and its light */}
      <rect className="bx bx--front" x="178" y="34" width="38" height="84" rx="6" />
      <line className="ln ln--thin" x1="186" y1="52" x2="208" y2="52" />
      <line className="ln ln--thin" x1="186" y1="66" x2="208" y2="66" />
      <line className="ln ln--thin" x1="186" y1="80" x2="208" y2="80" />
      <circle className="ring" cx="197" cy="102" r="6" />
      <circle className="ring ring--pulse" cx="197" cy="102" r="6" />
      <circle className="dot dot--c" cx="197" cy="102" r="2.6" />
    </svg>
  )
}

/** The ended state of a chat on a Clave server: the drawing, the server's
 *  name, one line, and Resume as the way on. The same restart the tab's
 *  header button makes, under the same id, the conversation resumed where
 *  the server can resume it; a failure is said here, in the pane. */
export function ServerEnded({
  sessionId,
  exitCode
}: {
  sessionId: string
  exitCode?: number
}): React.JSX.Element {
  const owner = ownerOf(sessionId)
  const name = useFleetStore((s) => s.connections.find((c) => c.id === owner)?.name)
  const status = useFleetStore((s) => s.statuses[owner]?.state)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const server = name ?? 'the server'
  const resume = (): void => {
    setBusy(true)
    setFailure(null)
    void restartSessionProcess(sessionId, { onlyIfStopped: true })
      .then(async (result) => {
        if (!result.ok) throw new Error(result.error ?? 'The server did not resume the chat')
        await window.electronAPI.fleetSnapshot(owner)
      })
      .catch((error: unknown) =>
        setFailure(`Resume failed: ${error instanceof Error ? error.message : String(error)}`)
      )
      .finally(() => setBusy(false))
  }
  return (
    <div className="chat-empty view-empty chat-ended-server" data-chat-ended="server" role="status">
      <ServerEndedDrawing />
      <p className="chat-drop-eyebrow">{server}</p>
      <strong>
        Session ended on {server}
        {exitCode !== undefined ? ` (exit ${exitCode})` : ''}
      </strong>
      <span>
        The server stopped this conversation, on a restart or on its own.{' '}
        {status === 'connected' ? (
          <>
            <button
              type="button"
              className="chat-notice-action"
              disabled={busy}
              onClick={resume}
              data-chat-resume
            >
              Resume
            </button>{' '}
            brings it back where {server} left it, in the mode and on the model it was running.
          </>
        ) : (
          `Resume is offered once ${server} is connected again.`
        )}
      </span>
      {failure ? (
        <span className="chat-ended-server-failure" role="alert" data-fleet-resume-error>
          {failure}
        </span>
      ) : null}
    </div>
  )
}
