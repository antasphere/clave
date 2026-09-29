import { ArrowTurnDownRightIcon } from '@heroicons/react/24/outline'
import type { ProvenanceSender } from '../../../src/shared/exchange-provenance'
import { useSessionStore } from '../../../src/renderer/src/store/session-store'

/** Who sent a message that came from another tab (clave_send_to_session),
 *  set at the head of the message in place of the bracketed header. The tab
 *  opens on a click when it is in this window; one elsewhere, or gone, is
 *  named only. */
export function SenderChip({ sender }: { sender: ProvenanceSender | null }): React.JSX.Element {
  const id = sender?.id
  const here = useSessionStore((state) => !!id && state.sessions.some((s) => s.id === id))
  const name = sender?.name ?? 'Another agent'
  const label = (
    <>
      <ArrowTurnDownRightIcon aria-hidden="true" />
      <span className="chat-turn-from-name">{name}</span>
    </>
  )
  return here && id ? (
    <button
      type="button"
      className="chat-turn-from"
      title={`From the tab “${name}” — open it`}
      onClick={(event) => {
        // The row's own click is the transcript's; this one is the tab's.
        event.stopPropagation()
        useSessionStore.getState().selectSession(id, false)
      }}
    >
      {label}
    </button>
  ) : (
    <span className="chat-turn-from" title={`From the tab “${name}”`}>
      {label}
    </span>
  )
}
