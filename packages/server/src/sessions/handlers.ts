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
  ReadSessionScreen,
  RenameSession,
  RestartSession,
  SessionScreenUnavailable,
  SetSessionPage,
  TypeIntoSession,
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
import { ServerEvents } from '../events'

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
  ),
  // ── Wave 4, lane D: the last agent tools (PRDCT-3377). What an agent did
  // to a session is a fact the windows follow, so each handler publishes it
  // once the host took it. ──
  CommandHandler.make(RenameSession, (payload) =>
    Effect.gen(function* () {
      const host = yield* SessionHost
      yield* known(host, payload.id)
      const session = host.rename(payload.id, payload.name)
      const events = yield* ServerEvents
      yield* events.publish({ _tag: 'session.renamed', id: payload.id, name: session.title })
      return session
    })
  ),
  CommandHandler.make(SetSessionPage, (payload) =>
    Effect.gen(function* () {
      const host = yield* SessionHost
      yield* known(host, payload.id)
      host.setPage(payload.id, payload.page)
      const events = yield* ServerEvents
      yield* events.publish({
        _tag: 'session.page_changed',
        id: payload.id,
        page: payload.page,
        servingSessionId: payload.servingSessionId
      })
    })
  ),
  QueryHandler.make(ReadSessionScreen, (payload) =>
    Effect.flatMap(SessionHost, (host) =>
      known(host, payload.id).pipe(
        Effect.flatMap(() =>
          Effect.tryPromise({
            try: () => host.screen(payload.id, payload.lines ?? 100),
            catch: (error) =>
              error instanceof SessionScreenUnavailable
                ? error
                : new SessionScreenUnavailable({ id: payload.id, message: messageOf(error) })
          })
        )
      )
    )
  ),
  CommandHandler.make(TypeIntoSession, (payload) =>
    Effect.gen(function* () {
      const host = yield* SessionHost
      yield* known(host, payload.id)
      const outcome = yield* Effect.tryPromise({
        try: () => host.type(payload.id, payload.text),
        catch: (error) => new SessionWriteRefused({ id: payload.id, message: messageOf(error) })
      })
      const events = yield* ServerEvents
      yield* events.publish({ _tag: 'session.typed', id: payload.id, from: payload.from ?? null })
      return outcome
    })
  ),
  CommandHandler.make(RestartSession, (payload) =>
    Effect.gen(function* () {
      const host = yield* SessionHost
      yield* known(host, payload.id)
      const events = yield* ServerEvents
      // Said before the kill: the window hears the exit of the old process
      // first otherwise, and announces the tab as ended.
      yield* events.publish({ _tag: 'session.restarting', id: payload.id })
      const restarted = yield* Effect.tryPromise({
        try: () => host.restart(payload.id, payload.account, payload.resendRejected === true),
        catch: (error) =>
          error instanceof CapabilityUnavailable
            ? error
            : new SessionStartFailed({ message: messageOf(error) })
      })
      yield* events.publish({
        _tag: 'session.restarted',
        id: payload.id,
        resumed: restarted.resumed,
        account: payload.account
      })
      return restarted
    })
  )
] as const
