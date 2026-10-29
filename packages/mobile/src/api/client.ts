/**
 * The phone's client of one Clave server over HTTP: the routes of the wire
 * contract the phone speaks (`../contract/types.ts`), on the platform's
 * `fetch`. Queries are GETs with the payload in the query string, commands
 * POSTs with a JSON body, every call under `Authorization: Bearer`. A 401 is
 * `unauthenticated`; a 422 carries a declared failure in the server's own
 * words; a deadline is 10 s on an ordinary call and 60 s on a page of
 * history, the desktop client's two deadlines.
 *
 * The client is given its credential and never stores it: the credential
 * store (`../machines/credentials.ts`) owns that.
 */
import {
  decodeFileText,
  decodeHistoryPage,
  decodeLaunchProfiles,
  decodeRequestSnapshot,
  decodeResolveOutcome,
  decodeServerFailure,
  decodeSession,
  decodeSessionCapabilities,
  decodeSessionInfo,
  decodeSessionRecords,
  decodeSessions,
  decodeWorkspaceState,
  decodeWriteStatus,
  decodeWriteAnswer
} from '../contract/decode'
import type {
  FileText,
  HistoryPage,
  LaunchProfilePreferencesView,
  RequestResponse,
  RequestSnapshot,
  ResolveOutcome,
  Session,
  SessionCapabilities,
  SessionInfo,
  SessionRecord,
  SessionWriteInput,
  StartSessionInput,
  WorkspaceStateView,
  WriteStatus,
  WriteAnswer
} from '../contract/types'
import { ServerError } from './errors'
import { credentialMayTravelTo, type BuildKind } from '../machines/transport-policy'

export interface Credential {
  /** The server's base URL: `http://127.0.0.1:43201`, or a relay road
   *  `https://relay.example/m/<machine>`. */
  readonly serverUrl: string
  readonly bearer: string
}

/** The subset of `fetch` the client uses, so a test hands it a stub. */
export type FetchLike = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST'
    readonly headers: Record<string, string>
    readonly body?: string
    readonly signal: AbortSignal
  }
) => Promise<{
  readonly status: number
  readonly ok: boolean
  text(): Promise<string>
}>

export interface ClaveServerClientOptions {
  readonly fetch?: FetchLike
  /** The ordinary deadline, 10 s by default. */
  readonly timeoutMs?: number
  /** The deadline of a page of history, 60 s by default. */
  readonly historyTimeoutMs?: number
  /** How the client names itself, for the server's log. */
  readonly client?: string
  /** Which build this is: decides the addresses a credential may go to
   *  (`transport-policy.ts`). Release by default: a caller opts into the
   *  development allowance explicitly. */
  readonly build?: BuildKind
}

export const DEFAULT_TIMEOUT_MS = 10_000
export const HISTORY_TIMEOUT_MS = 60_000

type Query = Record<string, string | number | undefined>

const trimSlash = (url: string): string => url.replace(/\/+$/, '')

const defaultFetch = (): FetchLike => {
  const f = (globalThis as { fetch?: unknown }).fetch
  if (typeof f !== 'function')
    throw new Error('No fetch in this environment: pass one in the options')
  return f as FetchLike
}

export class ClaveServerClient {
  readonly baseUrl: string
  private readonly fetch: FetchLike
  private readonly timeoutMs: number
  private readonly historyTimeoutMs: number

  constructor(
    private readonly credential: Credential,
    options: ClaveServerClientOptions = {}
  ) {
    this.baseUrl = trimSlash(credential.serverUrl)
    const verdict = credentialMayTravelTo(this.baseUrl, options.build ?? 'release')
    if (!verdict.ok) throw new ServerError('policy', verdict.reason)
    this.fetch = options.fetch ?? defaultFetch()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.historyTimeoutMs = options.historyTimeoutMs ?? HISTORY_TIMEOUT_MS
  }

  // ── sessions ──

  readonly sessions = {
    list: (): Promise<Session[]> => this.query('/sessions', {}, decodeSessions),
    get: (id: string): Promise<Session> => this.query('/sessions/by-id', { id }, decodeSession),
    start: (input: StartSessionInput): Promise<SessionInfo> =>
      this.command('/sessions/start', input, decodeSessionInfo),
    stop: (id: string): Promise<void> => this.command('/sessions/stop', { id }, () => undefined),
    write: (id: string, input: SessionWriteInput): Promise<WriteAnswer> =>
      this.command('/sessions/write', { id, input }, decodeWriteAnswer),
    restart: (id: string): Promise<SessionInfo> =>
      this.command('/sessions/restart', { id, account: {} }, decodeSessionInfo),
    capabilities: (id: string): Promise<SessionCapabilities> =>
      this.query('/sessions/capabilities', { id }, decodeSessionCapabilities),
    /** A page of the past ending at `before` (the end when absent), newest
     *  page first, oldest event first within it; `before: null` says there is
     *  no page before it. Under the long deadline. */
    history: (id: string, before?: number, limit?: number): Promise<HistoryPage> =>
      this.query(
        '/sessions/history',
        { id, before, limit },
        decodeHistoryPage,
        this.historyTimeoutMs
      ),
    /** What the server knows of a write by the id the phone minted (lane
     *  B's route). A server without the route answers 404, which the caller
     *  reads as `unknown`. */
    writeStatus: (id: string, clientMessageId: string): Promise<WriteStatus> =>
      this.query('/sessions/writes', { id, clientMessageId }, decodeWriteStatus),
    /** The records of these sessions, with the workspace each is stamped with. */
    records: (ids: readonly string[]): Promise<SessionRecord[]> =>
      ids.length === 0
        ? Promise.resolve([])
        : this.query('/sessions/records', { ids: ids.join(',') }, decodeSessionRecords)
  }

  // ── settings ──

  readonly launchProfiles = {
    list: (): Promise<LaunchProfilePreferencesView> =>
      this.query('/launch-profiles', {}, decodeLaunchProfiles)
  }

  readonly workspaces = {
    load: (): Promise<WorkspaceStateView> => this.query('/workspaces', {}, decodeWorkspaceState)
  }

  // ── requests ──

  readonly requests = {
    list: (): Promise<RequestSnapshot> =>
      this.query('/requests/pending', {}, decodeRequestSnapshot),
    resolve: (requestId: string, response: RequestResponse): Promise<ResolveOutcome> =>
      this.command('/requests/resolve', { requestId, response }, decodeResolveOutcome)
  }

  // ── files ──

  readonly files = {
    /** The text of a file on the server's disk, bounded by `root`. */
    read: (root: string, path: string): Promise<FileText> =>
      this.query('/files/read', { root, path }, decodeFileText)
  }

  // ── the wire ──

  private async query<T>(
    path: string,
    params: Query,
    decode: (value: unknown, path: string) => T,
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) search.set(key, String(value))
    const qs = search.toString()
    return this.send('GET', `${path}${qs ? `?${qs}` : ''}`, undefined, decode, timeoutMs)
  }

  private command<T>(
    path: string,
    body: unknown,
    decode: (value: unknown, path: string) => T
  ): Promise<T> {
    return this.send('POST', path, JSON.stringify(body), decode, this.timeoutMs)
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    decode: (value: unknown, path: string) => T,
    timeoutMs: number
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const url = `${this.baseUrl}${path}`
    let status: number
    let text: string
    try {
      const response = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.credential.bearer}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal
      })
      status = response.status
      text = await response.text()
    } catch (cause) {
      if (controller.signal.aborted)
        throw new ServerError(
          'timeout',
          `The server did not answer within ${timeoutMs / 1000} s.`,
          {
            cause
          }
        )
      throw new ServerError('network', 'The server could not be reached.', { cause })
    } finally {
      clearTimeout(timer)
    }
    if (status === 401)
      throw new ServerError('unauthenticated', 'The server refused the token.', { status })
    let json: unknown = undefined
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        if (status >= 200 && status < 300)
          throw new ServerError('protocol', 'The server answered something unreadable.', { status })
      }
    }
    if (status === 422) {
      let failure
      try {
        failure = decodeServerFailure(json)
      } catch {
        throw new ServerError('protocol', `The server refused (422) without a readable reason.`, {
          status
        })
      }
      throw new ServerError('refused', failure.message, { status, failure })
    }
    if (status < 200 || status >= 300)
      throw new ServerError('protocol', `The server answered ${status}.`, { status })
    try {
      return decode(json, path)
    } catch (cause) {
      throw new ServerError(
        'protocol',
        `The server's answer to ${path} does not have the expected shape: ${cause instanceof Error ? cause.message : String(cause)}`,
        { status, cause }
      )
    }
  }
}
