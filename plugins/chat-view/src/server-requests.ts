import type { FleetPendingRequest } from '../../../src/preload/fleet-types'
import type { Entry, Permission } from './reducer'

/* A server session's open requests are the server's own records, never this
   view's reading of its stream (#261). A provider's request id names no one
   request: Codex numbers its requests from zero again in every process, so
   the same id can come back for another question. The server keeps one record
   per request, under a key of its own that is never reused, and settles each
   once for every client attached to it. So a server session's dock shows
   those records and answers them by that key, through the route the request
   dialog uses; nothing a prompt holds can pass to another request. */

/** The dock of a server session: the requests its agent raised through its
 *  provider that the server still holds, oldest first, each identified by the
 *  server's request key (`clave-owner:request:…`). The masking comes from the
 *  record itself (`questionIsPrivate` reads its raw input, the same flag the
 *  server derives its secret questions from). */
export function serverDock(
  pending: readonly FleetPendingRequest[] | undefined,
  sessionId: string
): Permission[] {
  return (pending ?? [])
    .filter((r) => r.sessionId === sessionId && r.providerRequestId !== undefined)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => ({
      type: 'permission_request',
      id: r.id,
      description: r.description,
      options: (r.options ?? []).map((o) => ({ id: o.id, label: o.label })),
      ...(r.questions && {
        questions: r.questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) }))
      }),
      ...(r.toolName !== undefined && { toolName: r.toolName }),
      ...(r.input !== undefined && { input: r.input }),
      ...(r.detail !== undefined && { detail: r.detail })
    }))
}

/** The transcript's rows of a server session: an unanswered request the
 *  server no longer holds was answered elsewhere, since every other client
 *  learns of an answer only from the server's list going down. Without a
 *  server list (a local session) the entries are the view's own and pass
 *  through untouched. */
export function withServerPending(
  entries: Entry[],
  pending: readonly FleetPendingRequest[] | undefined,
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

/** The entries a question card is drawn for (PRDCT-4157): one per request
 *  still waiting, on its LATEST entry. A provider's request id names no one
 *  request across processes (Codex numbers from zero again), so an earlier
 *  entry under the same id, a dead process's question or a replayed duplicate,
 *  stays a muted row, never a second live card. A server session's live
 *  requests are the server's own records for that session, nothing the view
 *  read off its stream; a local session's are its unanswered entries. */
export function liveQuestionCards(
  entries: readonly Entry[],
  pending: readonly FleetPendingRequest[] | undefined,
  sessionId: string
): Set<Entry> {
  const server = pending
    ? new Set(
        pending
          .filter((r) => r.sessionId === sessionId && r.providerRequestId !== undefined)
          .map((r) => r.providerRequestId as string)
      )
    : null
  const live = new Set<Entry>()
  const seen = new Set<string>()
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind !== 'permission') continue
    const id = entry.request.id
    // The latest entry under an id speaks for it, answered or not: an older
    // one never comes back to life once the latest is settled.
    if (seen.has(id)) continue
    seen.add(id)
    if (entry.answer || entry.answeredElsewhere) continue
    if (server && !server.has(id)) continue
    live.add(entry)
  }
  return live
}

/** The server's record a card of `sessionId` answers: by the server's own
 *  key (the dock) or by the provider's id the stream carried (a card inline),
 *  and always that session's. A provider's id names no one request across
 *  sessions (Codex numbers from zero per process), so a lookup without the
 *  session could settle another session's request with this person's answer. */
export function remoteRequestFor(
  pending: readonly FleetPendingRequest[] | undefined,
  sessionId: string,
  id: string
): FleetPendingRequest | undefined {
  return pending?.find(
    (r) => r.sessionId === sessionId && (r.id === id || r.providerRequestId === id)
  )
}
