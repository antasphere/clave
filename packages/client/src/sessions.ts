/**
 * The sessions domain of the typed client: every call of
 * `@clave/contract/sessions` as a promise, over the derived request client.
 * The stream itself is the push client's (`PushClient.subscribe`), never a
 * request. One module per domain is the pattern: a lane adds its own file
 * with a `<domain>Client(call)` and one line in `api.ts`.
 */
import { Schema } from 'effect'
import {
  type CommandOption,
  type HistoryPage,
  type ModelOption,
  type ReleaseOutcome,
  type Session,
  type SessionCapabilities,
  type SessionInfo,
  type SessionRecord,
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
    )
})
