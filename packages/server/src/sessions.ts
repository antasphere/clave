/**
 * The sessions domain on the server, answered from the session source the
 * shell provides. Listing, one record, and a write; the stream itself goes
 * over the push channel (`push/hub.ts`), never over a request.
 */
import { Effect } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import { GetSession, ListSessions, SessionNotFound, WriteSession } from '@clave/contract/sessions'
import { SessionSource } from './ports'

export const sessionHandlers = [
  QueryHandler.make(ListSessions, (payload) =>
    Effect.map(SessionSource, (source) => source.list(payload.windowKey))
  ),
  QueryHandler.make(GetSession, (payload) =>
    Effect.flatMap(SessionSource, (source) => {
      const session = source.get(payload.id)
      return session
        ? Effect.succeed(session)
        : Effect.fail(new SessionNotFound({ id: payload.id }))
    })
  ),
  CommandHandler.make(WriteSession, (payload) =>
    Effect.flatMap(SessionSource, (source) =>
      source.get(payload.id)
        ? Effect.sync(() => source.write(payload.id, payload.input))
        : Effect.fail(new SessionNotFound({ id: payload.id }))
    )
  )
] as const
