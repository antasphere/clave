/**
 * The sessions port: what the server needs from whoever runs the sessions.
 * Inside the app the shell implements it over the session manager and the
 * PTY manager it already has (`src/main/server/session-host.ts`); a
 * standalone server without a terminal process runs on `SessionHost.none`,
 * which lists nothing and answers every start with `CapabilityUnavailable`,
 * so a client is told rather than left waiting.
 *
 * The methods are plain promises and synchronous calls, not Effects: the
 * port is implemented by the shell in plain TypeScript, and the handlers
 * (`handlers.ts`) are where a thrown error becomes a declared failure.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type {
  CommandOption,
  HistoryPage,
  ModelOption,
  Session,
  SessionCapabilities,
  SessionInfo,
  SessionStream,
  SessionWrite,
  SpawnOptions
} from '@clave/contract/sessions'

export type Unsubscribe = () => void

export interface StartInput {
  readonly cwd: string
  readonly windowKey?: string | undefined
  readonly options?: SpawnOptions | undefined
}

/** The part of the port the push hub reads: records and streams. */
export interface SessionStreamSource {
  readonly get: (id: string) => Session | undefined
  /** Frames of a session as they come; throws when the session is unknown.
   *  The implementation makes the session ready on the first subscription
   *  and replays what a late subscriber must know (the background tasks). */
  readonly subscribe: (id: string, listener: (stream: SessionStream) => void) => Unsubscribe
  /** The session's exit code, once; throws when the session is unknown. */
  readonly subscribeExit: (id: string, listener: (code: number) => void) => Unsubscribe
}

export interface SessionHostService extends SessionStreamSource {
  /** Every session, or those of one window when `windowKey` is given. */
  readonly list: (windowKey?: string) => ReadonlyArray<Session>
  /** Start a session; rejects with `CapabilityUnavailable` when this host
   *  runs none, with any other error when the start itself failed. */
  readonly start: (input: StartInput) => Promise<SessionInfo>
  /** Stop a session; a session already gone is not an error. */
  readonly stop: (id: string) => Promise<void>
  /** Hand the session a typed input or terminal bytes; throws when it is
   *  unknown, rejects when the provider or the preparation refused it. */
  readonly write: (id: string, input: SessionWrite) => Promise<void>
  readonly setView: (id: string, viewId: string | null) => Session
  readonly models: (id: string) => Promise<ReadonlyArray<ModelOption>>
  readonly commands: (id: string) => Promise<ReadonlyArray<CommandOption>>
  readonly capabilities: (id: string) => SessionCapabilities
  readonly history: (id: string, before?: number, limit?: number) => HistoryPage
}

const NO_SESSIONS = new CapabilityUnavailable({
  capability: 'sessions',
  message:
    'This server runs no sessions yet: a standalone Clave server gets its terminal process in the next wave.'
})

export class SessionHost extends Context.Tag('@clave/server/SessionHost')<
  SessionHost,
  SessionHostService
>() {
  static layer(service: SessionHostService): Layer.Layer<SessionHost> {
    return Layer.succeed(SessionHost, service)
  }
  /** A host with no sessions: a standalone server before its terminal
   *  process exists, and the tests' default. Reads answer empty, writes
   *  answer unknown, a start says what is missing. */
  static readonly none: SessionHostService = {
    list: () => [],
    get: () => undefined,
    subscribe: (id) => {
      throw new Error(`Unknown session: ${id}`)
    },
    subscribeExit: (id) => {
      throw new Error(`Unknown session: ${id}`)
    },
    start: () => Promise.reject(NO_SESSIONS),
    stop: () => Promise.reject(NO_SESSIONS),
    write: (id) => Promise.reject(new Error(`Unknown session: ${id}`)),
    setView: (id) => {
      throw new Error(`Unknown session: ${id}`)
    },
    models: (id) => Promise.reject(new Error(`Unknown session: ${id}`)),
    commands: (id) => Promise.reject(new Error(`Unknown session: ${id}`)),
    capabilities: (id) => {
      throw new Error(`Unknown session: ${id}`)
    },
    history: (id) => {
      throw new Error(`Unknown session: ${id}`)
    }
  }
}
