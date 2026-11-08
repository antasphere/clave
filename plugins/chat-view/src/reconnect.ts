import { isRemoteKey, ownerOf } from '../../../src/renderer/src/lib/fleet-identity'

/**
 * A pane's word that its server's connection came back (PRDCT-4191). Runs
 * are ordered within one host lifetime only, and the connection coming back
 * may be to a server that restarted and counts from 1 again, so the pane
 * forgets the run it heard before any frame of the new connection arrives:
 * the push client says `open` BEFORE it subscribes again, and the listener
 * is bound at the top of the pane's effect, ahead of every stream listener,
 * so the order is the code's, not timing's. Nothing is bound for a tab of
 * this Mac, whose host never changes under it. One helper for the chat
 * view, the terminal view and the Folio lab, pinned by `reconnect.test.ts`.
 */
export function bindReconnectReset(sessionId: string, onReconnect: () => void): () => void {
  if (!isRemoteKey(sessionId) || !window.electronAPI.onFleetStatus) return () => {}
  let live = true
  const stop = window.electronAPI.onFleetStatus((status) => {
    if (live && status.serverId === ownerOf(sessionId) && status.state === 'connected')
      onReconnect()
  })
  return () => {
    live = false
    stop()
  }
}
