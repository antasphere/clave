import type { Session } from '../../../shared/session-model'

/* An end heard on a session's channels (its `ended` state, its exit code) is
   not always that session's end. A tab moved to another account (ADR 0002)
   keeps its id: main stops the old process, whose `ended` and exit it sends,
   then spawns the new one and answers the restart. Electron orders `send`
   messages among themselves but not against an `invoke` reply, so the pane
   can remount on the new process and THEN hear the old one's end — which read
   as "Session ended (exit 1)" over a live agent. The session record in main
   is the arbiter: a session that really ended is on record as ended, or gone;
   a record under the id in any other state is a live session, and the word
   was its predecessor's. */

/** Whether the end just heard for `sessionId` is the session's own. */
export async function endIsCurrent(
  sessionId: string,
  sessionsList: () => Promise<Session[]> = () => window.electronAPI.sessionsList()
): Promise<boolean> {
  const record = (await sessionsList()).find((s) => s.id === sessionId)
  return !record || record.state === 'ended'
}
