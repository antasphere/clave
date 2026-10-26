import type { Entry, Permission } from './reducer'

/** What a server says is still waiting: its pending requests, each naming the
 *  session and the provider's own request id it holds open. */
export interface ServerPending {
  sessionId: string
  providerRequestId?: string
}

/** A session on a server reads its open requests off the server, not off its
 *  own stream: the server holds each one until one client answers it, and
 *  every other client learns it was answered only from the server's pending
 *  list going down. So an unanswered request the server no longer holds is
 *  answered elsewhere. Without a server list (a local session) the entries are
 *  the view's own and pass through untouched. */
export function withServerPending(
  entries: Entry[],
  pending: readonly ServerPending[] | undefined,
  sessionId: string
): Entry[] {
  if (!pending) return entries
  return entries.map((entry) =>
    entry.kind === 'permission' && !entry.answer
      ? {
          ...entry,
          answeredElsewhere: !pending.some(
            (r) => r.sessionId === sessionId && r.providerRequestId === entry.request.id
          )
        }
      : entry
  )
}

/** What the agent waits on, oldest first: the dock shows the head of it. The
 *  same reading as the transcript's rows, so the dock and the row beside it
 *  never disagree about whether a request is still open. */
export function openRequests(
  entries: Entry[],
  pending: readonly ServerPending[] | undefined,
  sessionId: string
): Permission[] {
  return withServerPending(entries, pending, sessionId).flatMap((e) =>
    e.kind === 'permission' && !e.answer && !e.answeredElsewhere ? [e.request] : []
  )
}
