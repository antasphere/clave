import type { Session } from '../../../shared/session-model'
import { isRemoteKey, ownerOf } from '../lib/fleet-identity'

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

/** Whether the end just heard for `sessionId` is the session's own. A tab on
 *  a Clave server is asked of that server now (its snapshot read again,
 *  PRDCT-4191, round 3 C1): the list this window holds of a server is the
 *  last snapshot it took, which a restart leaves stale, so a chat that never
 *  ran a process stayed live on the Mac while the server held it ended. */
export async function endIsCurrent(
  sessionId: string,
  sessionsList: () => Promise<Session[]> = () => window.electronAPI.sessionsList(),
  serverSessions: (serverId: string) => Promise<Pick<Session, 'id' | 'state'>[]> = async (
    serverId
  ) => (await window.electronAPI.fleetSnapshot(serverId)).sessions
): Promise<boolean> {
  if (isRemoteKey(sessionId)) {
    // A server that cannot be asked (its daemon stopping) is not running the
    // chat for this window: the end is taken, and a server that comes back
    // running it says so at the next bind, which the pane applies (round 4).
    const asked = await serverSessions(ownerOf(sessionId)).then(
      (sessions) => ({ ok: true as const, sessions }),
      () => ({ ok: false as const })
    )
    if (!asked.ok) return true
    const record = asked.sessions.find((s) => s.id === sessionId)
    return !record || record.state === 'ended'
  }
  const record = (await sessionsList()).find((s) => s.id === sessionId)
  return !record || record.state === 'ended'
}
