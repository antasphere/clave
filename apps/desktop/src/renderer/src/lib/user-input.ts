import { useSessionStore } from '../store/session-store'
import { getDraftShadow } from './draft-shadow'

/**
 * The one write path for USER input into a local session's PTY. Every
 * renderer writer of user-originated input (xterm onData, custom key
 * bindings, drag-drop and file-palette path insertion) must go through here
 * so the session's draft shadow sees exactly what the CLI's input buffer
 * sees — that is what lets clave_send_to_session stash, clear, and restore a
 * half-typed draft instead of co-submitting it (PRDCT-1569).
 *
 * App-originated writes are NOT user input and stay on writeSession directly:
 * the dispatcher's own injection writes (accounted for via begin/endInjection)
 * and the server-button command/Ctrl+C writes into plain terminal sessions.
 *
 * While the CLI shows a permission prompt the keystrokes drive a dialog, not
 * the input line, so they are fed as opaque (the Enter that answers the
 * dialog must not read as a submit).
 */
export function writeUserInput(sessionId: string, data: string): void {
  const shadow = getDraftShadow(sessionId)
  const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId)
  if (s && (s.promptWaiting !== null || s.agentState === 'blocked')) shadow.noteOpaqueInput()
  else shadow.feed(data)
  window.electronAPI.writeSession(sessionId, data)
}
