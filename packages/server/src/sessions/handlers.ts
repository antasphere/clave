/**
 * The sessions domain on the server: every command and query of
 * `@clave/contract/sessions`, answered from the session host the entry
 * provides. The stream itself goes over the push channel (`push/hub.ts`),
 * never over a request. What the host throws becomes a declared failure
 * here, so a client reads a 422 it knows and never a 500.
 */
import { Effect } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  GetSession,
  GetSessionCapabilities,
  GetSessionCommands,
  GetSessionHistory,
  GetSessionModels,
  ListSessions,
  type Session,
  SessionNotFound,
  SessionStartFailed,
  SessionStopFailed,
  SessionWriteRefused,
  SetSessionView,
  StartSession,
  StopSession,
  ResizeSession,
  WriteSession,
  // ── Wave 4, lane C: the session records and a session's release ──
  DiscardSessionRecord,
  ListAdoptableRecords,
  ReleaseSessions
} from '@clave/contract/sessions'
import { SessionHost, type SessionHostService } from './port'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The record, or the declared failure for an id this host does not know. */
const known = (host: SessionHostService, id: string): Effect.Effect<Session, SessionNotFound> => {
  const session = host.get(id)
  return session ? Effect.succeed(session) : Effect.fail(new SessionNotFound({ id }))
}

export const sessionHandlers = [
  QueryHandler.make(ListSessions, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      Effect.try({
        try: () => host.list(payload.windowKey),
        catch: (error) =>
          error instanceof CapabilityUnavailable
            ? error
            : // Anything else a host throws on a list is a bug in the host.
              new CapabilityUnavailable({ capability: 'sessions', message: messageOf(error) })
      })
    )
  ),
  QueryHandler.make(GetSession, (payload) =>
    Effect.flatMap(SessionHost, (host) => known(host, payload.id))
  ),
  CommandHandler.make(StartSession, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      Effect.tryPromise({
        try: () => host.start(payload),
        catch: (error) =>
          error instanceof CapabilityUnavailable
            ? error
            : new SessionStartFailed({ message: messageOf(error) })
      })
    )
  ),
  CommandHandler.make(StopSession, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      Effect.tryPromise({
        try: () => host.stop(payload.id),
        catch: (error) =>
          error instanceof CapabilityUnavailable
            ? error
            : // What the kill threw, as its own failure: a stop that fails for
              // a reason of its own is not "this server runs no sessions".
              new SessionStopFailed({ id: payload.id, message: messageOf(error) })
      })
    )
  ),
  CommandHandler.make(WriteSession, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      known(host, payload.id).pipe(
        Effect.flatMap(() =>
          Effect.tryPromise({
            try: () => host.write(payload.id, payload.input),
            catch: (error) => new SessionWriteRefused({ id: payload.id, message: messageOf(error) })
          })
        )
      )
    )
  ),
  CommandHandler.make(ResizeSession, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      known(host, payload.id).pipe(
        Effect.flatMap(() =>
          Effect.try({
            try: () => host.resize(payload.id, payload.cols, payload.rows),
            catch: (error) =>
              error instanceof CapabilityUnavailable
                ? error
                : new SessionWriteRefused({ id: payload.id, message: messageOf(error) })
          })
        )
      )
    )
  ),
  CommandHandler.make(SetSessionView, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      known(host, payload.id).pipe(
        Effect.flatMap(() =>
          Effect.try({
            try: () => host.setView(payload.id, payload.viewId),
            catch: (error) => new SessionWriteRefused({ id: payload.id, message: messageOf(error) })
          })
        )
      )
    )
  ),
  QueryHandler.make(GetSessionModels, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      known(host, payload.id).pipe(
        Effect.flatMap(() => Effect.promise(() => host.models(payload.id)))
      )
    )
  ),
  QueryHandler.make(GetSessionCommands, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      known(host, payload.id).pipe(
        Effect.flatMap(() => Effect.promise(() => host.commands(payload.id)))
      )
    )
  ),
  QueryHandler.make(GetSessionCapabilities, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      known(host, payload.id).pipe(Effect.map(() => host.capabilities(payload.id)))
    )
  ),
  QueryHandler.make(GetSessionHistory, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      known(host, payload.id).pipe(
        Effect.map(() => host.history(payload.id, payload.before, payload.limit))
      )
    )
  ),
  // ── Wave 4, lane C: the session records, and a session's release (PRDCT-3376) ──
  // The host keeps the records (the terminal layer's documents under its
  // storage); what it throws beyond the declared failure is a bug in the
  // host, said as the capability rather than as a 500.
  QueryHandler.make(ListAdoptableRecords, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      Effect.try({
        try: () => host.listAdoptableRecords(payload.ids),
        catch: (error) =>
          error instanceof CapabilityUnavailable
            ? error
            : new CapabilityUnavailable({ capability: 'sessions', message: messageOf(error) })
      })
    )
  ),
  CommandHandler.make(DiscardSessionRecord, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      Effect.try({
        try: () => host.discardRecord(payload.key),
        catch: (error) =>
          error instanceof CapabilityUnavailable
            ? error
            : new CapabilityUnavailable({ capability: 'sessions', message: messageOf(error) })
      })
    )
  ),
  CommandHandler.make(ReleaseSessions, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      Effect.try({
        try: () => host.release(payload.ids, payload.fallbackWindowKey),
        catch: (error) =>
          error instanceof CapabilityUnavailable
            ? error
            : new CapabilityUnavailable({ capability: 'sessions', message: messageOf(error) })
      })
    )
  )
] as const
