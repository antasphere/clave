import type { Entry, Permission } from './reducer'

/** What a server says is still waiting: its pending requests, each naming the
 *  session and the provider's own request id it holds open. */
export interface ServerPending {
  sessionId: string
  providerRequestId?: string
}

/** Which requests are still open. An id means the latest request carrying it:
 *  a provider that restarted numbers its requests from zero again, so an
 *  older request under the same id is another question, closed whatever the
 *  server holds now (reopening it would answer the live request with the old
 *  one's questions and masking). A session on a server then reads what is
 *  open off the server, not off its own stream: the server holds each request
 *  until one client answers it, and every other client learns it was answered
 *  only from the server's pending list going down. So an unanswered request
 *  the server no longer holds is answered elsewhere. Without a server list (a
 *  local session) the latest requests keep the view's own reading. Nothing
 *  changed, the same array comes back. */
export function withServerPending(
  entries: Entry[],
  pending: readonly ServerPending[] | undefined,
  sessionId: string
): Entry[] {
  const latest = new Map<string, number>()
  entries.forEach((e, i) => {
    if (e.kind === 'permission') latest.set(e.request.id, i)
  })
  let changed = false
  const next = entries.map((entry, i) => {
    if (entry.kind !== 'permission' || entry.answer) return entry
    const superseded = latest.get(entry.request.id) !== i
    const elsewhere = superseded
      ? true
      : pending
        ? !pending.some(
            (r) => r.sessionId === sessionId && r.providerRequestId === entry.request.id
          )
        : entry.answeredElsewhere
    if (elsewhere === entry.answeredElsewhere) return entry
    changed = true
    return { ...entry, answeredElsewhere: elsewhere }
  })
  return changed ? next : entries
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
