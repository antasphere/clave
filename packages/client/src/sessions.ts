/**
 * The sessions domain of the typed client: every call of
 * `@clave/contract/sessions` as a promise, over the derived request client.
 * The stream itself is the push client's (`PushClient.subscribe`), never a
 * request. One module per domain is the pattern: a lane adds its own file
 * with a `<domain>Client(call)` and one line in `api.ts`.
 */
import { Schema } from 'effect'
import {
  type AccountOverride,
  type CommandOption,
  type DraftHandling,
  type HistoryPage,
  type ModelOption,
  type ReleaseOutcome,
  type RestartedSession,
  type Session,
  type SessionCapabilities,
  type SessionInfo,
  type SessionPage,
  type SessionRecord,
  type SessionScreen,
  SessionWrite,
  type SpawnOptions
} from '@clave/contract/sessions'
import type { Call } from './call'

export interface StartSessionInput {
  readonly cwd: string
  readonly windowKey?: string
  readonly options?: SpawnOptions
}

export interface SessionsClient {
  readonly list: (windowKey?: string) => Promise<ReadonlyArray<Session>>
  readonly get: (id: string) => Promise<Session>
  readonly start: (input: StartSessionInput) => Promise<SessionInfo>
  readonly stop: (id: string) => Promise<void>
  readonly write: (id: string, input: SessionWrite) => Promise<void>
  /** A terminal's size from its pane; the first one starts the process. */
  readonly resize: (id: string, cols: number, rows: number) => Promise<void>
  readonly setView: (id: string, viewId: string | null) => Promise<Session>
  readonly models: (id: string) => Promise<ReadonlyArray<ModelOption>>
  readonly commands: (id: string) => Promise<ReadonlyArray<CommandOption>>
  readonly capabilities: (id: string) => Promise<SessionCapabilities>
  readonly history: (id: string, before?: number, limit?: number) => Promise<HistoryPage>
  // ── Wave 4, lane C: the session records, and a session's release (PRDCT-3376) ──
  /** The records a window may bring back: every adoptable one, or those of
   *  `ids` (the sessions the server runs among them marked `running`). */
  readonly listAdoptable: (ids?: ReadonlyArray<string>) => Promise<ReadonlyArray<SessionRecord>>
  /** Destroy a surviving session nobody brings back, by its record key. */
  readonly discardRecord: (key: string) => Promise<void>
  /** Let go of live sessions for another window to take in. */
  readonly release: (
    ids: ReadonlyArray<string>,
    fallbackWindowKey?: string
  ) => Promise<ReleaseOutcome>
  // ── Wave 4, lane D: the last agent tools (PRDCT-3377) ──
  /** The tab's name, protected from the auto-title. */
  readonly rename: (id: string, name: string) => Promise<Session>
  /** The page on the tab's row, with the session serving it; null takes it off. */
  readonly setPage: (
    id: string,
    page: SessionPage | null,
    servingSessionId: string | null
  ) => Promise<void>
  /** The last rendered lines of a terminal session, 100 by default. */
  readonly screen: (id: string, lines?: number) => Promise<SessionScreen>
  /** A message typed into the session as one turn; `from` names the sender's tab. */
  readonly type: (
    id: string,
    text: string,
    from?: string
  ) => Promise<{ submitted: boolean; draftHandling: DraftHandling }>
  /** The same tab restarted on another account under the same id. */
  readonly restart: (
    id: string,
    account: AccountOverride,
    resendRejected?: boolean
  ) => Promise<RestartedSession>
}

/** A write goes over the wire in its encoded form: bytes as base64. */
const encodeWrite = Schema.encodeSync(SessionWrite)
/** A GET carries its numbers as strings. */
const asParam = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : String(value)

export const sessionsClient = (call: Call): SessionsClient => ({
  list: (windowKey) =>
    call((c) => c.sessions.list({ payload: windowKey === undefined ? {} : { windowKey } })),
  get: (id) => call((c) => c.sessions.get({ payload: { id } })),
  start: (input) =>
    call((c) =>
      c.sessions.start({
        payload: {
          cwd: input.cwd,
          ...(input.windowKey !== undefined && { windowKey: input.windowKey }),
          ...(input.options !== undefined && { options: input.options })
        }
      })
    ),
  stop: (id) => call((c) => c.sessions.stop({ payload: { id } })).then(() => undefined),
  write: (id, input) =>
    call((c) => c.sessions.write({ payload: { id, input: encodeWrite(input) } })).then(
      () => undefined
    ),
  resize: (id, cols, rows) =>
    call((c) => c.sessions.resize({ payload: { id, cols, rows } })).then(() => undefined),
  setView: (id, viewId) => call((c) => c.sessions.setView({ payload: { id, viewId } })),
  models: (id) => call((c) => c.sessions.models({ payload: { id } })),
  commands: (id) => call((c) => c.sessions.commands({ payload: { id } })),
  capabilities: (id) => call((c) => c.sessions.capabilities({ payload: { id } })),
  history: (id, before, limit) =>
    call((c) =>
      c.sessions.history({
        payload: {
          id,
          ...(before !== undefined && { before: asParam(before) }),
          ...(limit !== undefined && { limit: asParam(limit) })
        }
      })
    ),
  // ── Wave 4, lane C: the records travel comma-joined on a GET (the contract says why) ──
  listAdoptable: (ids) =>
    call((c) =>
      c.sessions.listAdoptable({
        payload: ids === undefined ? {} : { ids: ids.join(',') }
      })
    ),
  discardRecord: (key) =>
    call((c) => c.sessions.discardRecord({ payload: { key } })).then(() => undefined),
  release: (ids, fallbackWindowKey) =>
    call((c) =>
      c.sessions.release({
        payload: {
          ids,
          ...(fallbackWindowKey !== undefined && { fallbackWindowKey })
        }
      })
    ),
  // ── Wave 4, lane D ──
  rename: (id, name) => call((c) => c.sessions.rename({ payload: { id, name } })),
  setPage: (id, page, servingSessionId) =>
    call((c) => c.sessions.setPage({ payload: { id, page, servingSessionId } })).then(
      () => undefined
    ),
  screen: (id, lines) =>
    call((c) =>
      c.sessions.screen({
        payload: { id, ...(lines !== undefined && { lines: asParam(lines) }) }
      })
    ),
  type: (id, text, from) =>
    call((c) => c.sessions.type({ payload: { id, text, ...(from !== undefined && { from }) } })),
  restart: (id, account, resendRejected) =>
    call((c) =>
      c.sessions.restart({
        payload: {
          id,
          account,
          ...(resendRejected !== undefined && { resendRejected })
        }
      })
    )
})
