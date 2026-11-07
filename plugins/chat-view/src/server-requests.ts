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
