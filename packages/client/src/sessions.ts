/**
 * The sessions domain of the typed client: every call of
 * `@clave/contract/sessions` as a promise, over the derived request client.
 * The stream itself is the push client's (`PushClient.subscribe`), never a
 * request. One module per domain is the pattern: a lane adds its own file
 * with a `<domain>Client(call)` and one line in `api.ts`.
 */
import { ParseResult, Schema } from 'effect'
import {
  type AccountOverride,
  type CommandOption,
  type DraftHandling,
  type HistoryPage,
  type ModelOption,
  type ProviderOverride,
  type ReleaseOutcome,
  type RestartedSession,
  type Session,
  type SessionCapabilities,
  type SessionControl,
  type SessionInfo,
  type SessionPage,
  type SessionRecordFields,
  type SessionRecord,
  type SessionScreen,
  SessionWrite,
  type SpawnOptions
} from '@clave/contract/sessions'
import type { WorkChange, WorkChangeResult } from '@clave/contract/work-rules'
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
  /** One control request to the session's provider, answered as it answered. */
  readonly control: (id: string, request: SessionControl) => Promise<Record<string, unknown>>
  readonly capabilities: (id: string) => Promise<SessionCapabilities>
  readonly history: (id: string, before?: number, limit?: number) => Promise<HistoryPage>
  // ── Wave 4, lane C: the session records, and a session's release (PRDCT-3376) ──
  /** The records a window may bring back: every adoptable one, or those of
   *  `ids` (the sessions the server runs among them marked `running`). */
  readonly listAdoptable: (ids?: ReadonlyArray<string>) => Promise<ReadonlyArray<SessionRecord>>
  /** Destroy a surviving session nobody brings back, by its record key. */
  readonly discardRecord: (key: string) => Promise<void>
  /** Wave 6, lane A: the window's name and page for a tab, on its record. */
  readonly keepOnRecord: (id: string, fields: SessionRecordFields) => Promise<void>
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
    resendRejected?: boolean,
    requestId?: string,
    onlyIfStopped?: boolean,
    /** The tab comes back on another provider (PRDCT-4300). */
    provider?: ProviderOverride
  ) => Promise<RestartedSession>
  // ── PRDCT-4123: which work a session does ──
  /** One change to the session's work assignment, answered with every record
   *  it rewrote, the session's own first, and the names an accepted handover
   *  gave. */
  readonly changeWork: (id: string, change: WorkChange) => Promise<WorkChangeResult>
}

/** A write goes over the wire in its encoded form: bytes as base64. A write
 *  the contract refuses fails with ONE readable line naming the field, never
 *  the schema's whole union tree, which is what a reader saw in the composer
 *  on 8 November 2026 when a dropped tab's key failed the pattern. */
const encodeWriteSync = Schema.encodeSync(SessionWrite)
const encodeWrite = (input: SessionWrite): typeof SessionWrite.Encoded => {
  try {
    return encodeWriteSync(input)
  } catch (error) {
    throw ParseResult.isParseError(error) ? new Error(refusedWrite(error)) : error
  }
}
/** The issue that went deepest is the one that names what was wrong; a union
 *  reports one shallow issue per branch it did not take. */
export function refusedWrite(error: ParseResult.ParseError): string {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error)
  const deepest = issues.reduce<(typeof issues)[number] | undefined>(
    (best, issue) => (!best || issue.path.length > best.path.length ? issue : best),
    undefined
  )
  if (!deepest) return 'Clave could not send this message.'
  const where = deepest.path.length ? `${deepest.path.join('.')}: ` : ''
  return `Clave could not send this message (${where}${deepest.message}).`
}
/** A GET carries its numbers as strings. */
const asParam = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : String(value)

/** `historyCall` is the same call under the history deadline
 *  (`HISTORY_TIMEOUT_MS`); the ordinary one serves when none is given. */
export const sessionsClient = (call: Call, historyCall: Call = call): SessionsClient => ({
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
  control: (id, request) =>
    call((c) => c.sessions.control({ payload: { id, request } })) as Promise<
      Record<string, unknown>
    >,
  capabilities: (id) => call((c) => c.sessions.capabilities({ payload: { id } })),
  history: (id, before, limit) =>
    historyCall((c) =>
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
  keepOnRecord: (id, fields) =>
    call((c) =>
      c.sessions.keepOnRecord({
        payload: {
          id,
          ...(fields.name !== undefined && { name: fields.name }),
          ...(fields.page !== undefined && { page: fields.page }),
          ...(fields.claudeSessionId !== undefined && { claudeSessionId: fields.claudeSessionId }),
          ...(fields.workspaceId !== undefined && { workspaceId: fields.workspaceId }),
          ...(fields.window !== undefined && { window: fields.window })
        }
      })
    ).then(() => undefined),
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
  restart: (id, account, resendRejected, requestId, onlyIfStopped, provider) =>
    call((c) =>
      c.sessions.restart({
        payload: {
          id,
          account,
          ...(resendRejected !== undefined && { resendRejected }),
          ...(requestId !== undefined && { requestId }),
          ...(onlyIfStopped !== undefined && { onlyIfStopped }),
          ...(provider !== undefined && { provider })
        }
      })
    ),
  // ── PRDCT-4123 ──
  changeWork: (id, change) =>
    call((c) => c.sessions.changeWork({ payload: { id, change } })).then((r) => ({
      changed: [...r.changed],
      renamed: [...r.renamed]
    }))
})
