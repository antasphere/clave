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
  AccountOverride,
  CommandOption,
  DraftHandling,
  HistoryPage,
  ModelOption,
  ReleaseOutcome,
  RestartedSession,
  Session,
  SessionCapabilities,
  SessionInfo,
  SessionRecord,
  SessionPage,
  SessionScreen,
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
  /** Every session, or those of one window when `windowKey` is given; throws
   *  `CapabilityUnavailable` on a host that runs no sessions at all. */
  readonly list: (windowKey?: string) => ReadonlyArray<Session>
  /** Start a session; rejects with `CapabilityUnavailable` when this host
   *  runs none, with any other error when the start itself failed. */
  readonly start: (input: StartInput) => Promise<SessionInfo>
  /** Stop a session; a session already gone is not an error. */
  readonly stop: (id: string) => Promise<void>
  /** Hand the session a typed input or terminal bytes; throws when it is
   *  unknown, rejects when the provider or the preparation refused it. */
  readonly write: (id: string, input: SessionWrite) => Promise<void>
  /** A terminal's size from its pane: the first one starts the process at
   *  it, a later one resizes it. Throws when the session is unknown, or
   *  `CapabilityUnavailable` when no terminal process can run it. */
  readonly resize: (id: string, cols: number, rows: number) => void
  readonly setView: (id: string, viewId: string | null) => Session
  readonly models: (id: string) => Promise<ReadonlyArray<ModelOption>>
  readonly commands: (id: string) => Promise<ReadonlyArray<CommandOption>>
  readonly capabilities: (id: string) => SessionCapabilities
  readonly history: (id: string, before?: number, limit?: number) => HistoryPage
  // ── Wave 4, lane C: the session records, and a session's release (PRDCT-3376) ──
  /** The records a window may bring back (`ListAdoptableRecords`): every
   *  adoptable one, or those of `ids` plus the records of the sessions this
   *  host runs by those ids, marked `running`. Throws `CapabilityUnavailable`
   *  on a host that keeps no records. */
  readonly listAdoptableRecords: (ids?: ReadonlyArray<string>) => ReadonlyArray<SessionRecord>
  /** Destroy a surviving session nobody brings back: its tmux session when
   *  it has one, then its record. Nothing happens for an unknown key. */
  readonly discardRecord: (key: string) => void
  /** Let go of live sessions for another window to take in: each tmux-backed
   *  one detached and unbound, the record kept; a plain one refused, and with
   *  `fallbackWindowKey` re-stamped there and detached all the same. */
  readonly release: (ids: ReadonlyArray<string>, fallbackWindowKey?: string) => ReleaseOutcome
  // ── Wave 4, lane D: the last agent tools (PRDCT-3377) ──
  /** The tab's name, on the record, protected from the auto-title; throws
   *  when the session is unknown. */
  readonly rename: (id: string, name: string) => Session
  /** The page on the tab's row, on the record; null takes it off. Throws
   *  when the session is unknown. */
  readonly setPage: (id: string, page: SessionPage | null) => void
  /** The last `lines` rendered lines of a terminal session. Throws when the
   *  session is unknown; rejects with `SessionScreenUnavailable` when it has
   *  no screen this host kept (a chat tab). */
  readonly screen: (id: string, lines: number) => Promise<SessionScreen>
  /** Type a message into the session as one turn and submit it (a terminal's
   *  draft set aside and put back, a chat's user message), answering whether
   *  the submit landed and what happened to the draft. Throws when the
   *  session is unknown, rejects when the write was refused. */
  readonly type: (
    id: string,
    text: string
  ) => Promise<{ submitted: boolean; draftHandling: DraftHandling }>
  /** The same tab restarted on another account under the same id; rejects
   *  with `CapabilityUnavailable` on a host that runs no sessions, with any
   *  other error when the restart could not be made. */
  readonly restart: (
    id: string,
    account: AccountOverride,
    resendRejected: boolean
  ) => Promise<RestartedSession>
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
   *  process exists, and the tests' default. The list and a start say what is
   *  missing (a window shows it where the sessions would be); a call on one
   *  session answers unknown, since there is none. */
  static readonly none: SessionHostService = {
    list: () => {
      throw NO_SESSIONS
    },
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
    resize: (id) => {
      throw new Error(`Unknown session: ${id}`)
    },
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
    },
    // ── Wave 4, lane C: a host with no sessions keeps no records either ──
    listAdoptableRecords: () => {
      throw NO_SESSIONS
    },
    discardRecord: () => {
      throw NO_SESSIONS
    },
    release: () => {
      throw NO_SESSIONS
    },
    // ── Wave 4, lane D ──
    rename: (id) => {
      throw new Error(`Unknown session: ${id}`)
    },
    setPage: (id) => {
      throw new Error(`Unknown session: ${id}`)
    },
    screen: (id) => Promise.reject(new Error(`Unknown session: ${id}`)),
    type: (id) => Promise.reject(new Error(`Unknown session: ${id}`)),
    restart: () => Promise.reject(NO_SESSIONS)
  }
}
