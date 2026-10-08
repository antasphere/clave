/**
 * The typed request client: every endpoint of `@clave/contract/api`, derived
 * from the shared `ClaveApi` type through `@structure-ai/client`, exposed as
 * promises so the preload and the renderer call it the way they call IPC. A
 * drift between server and client is a type error here. One namespace per
 * domain, each built in its own module (`sessions.ts`, `clients.ts`) from
 * the one `call`; a lane adds its module and its line below.
 */
import { Effect, Either, type Layer, ManagedRuntime, Schema } from 'effect'
import * as FetchHttpClient from '@effect/platform/FetchHttpClient'
import type * as HttpClient from '@effect/platform/HttpClient'
import * as HttpClientError from '@effect/platform/HttpClientError'
import { ForbiddenProblem, UnauthorizedProblem } from '@structure-ai/http'
import { type Call, type DerivedClient, deriveClient } from './call'
import { type ClientsClient, clientsClient } from './clients'
import { ServerRefused, ServerUnreachable } from './errors'
import { type SessionsClient, sessionsClient } from './sessions'
import { type SettingsClient, settingsClient } from './settings'
import { type SidebarClient, sidebarClient } from './sidebar'
import { type WorkspaceFilesClient, workspaceFilesClient } from './workspace-files'

export interface ApiClientOptions {
  readonly url: string
  readonly token: string
  /** Per-request deadline. Default: 10 seconds. */
  readonly timeoutMs?: number
  /** The deadline of the PATIENT calls: a `.clave` read the server holds for
   *  a review the person is reading, a recursive walk over a big tree. The
   *  server's review timeout (five minutes) plus a margin by default; it must
   *  stay above that timeout or a late answer trusts content for a read that
   *  is gone (round 1 of wave 3 lane A's verifier). */
  readonly patientTimeoutMs?: number
  /**
   * The HTTP client the requests go out through. The browser's `fetch` by
   * default (a page served from a loopback origin, with the server's CORS
   * answer). A preload running with Node available passes
   * `@effect/platform-node`'s client instead: the request then leaves
   * through Node's HTTP stack, with no Origin, no Content Security Policy
   * and no preflight, so the packaged `file://` window reaches the server
   * without the browser's cross-origin rules (ADR 0003).
   */
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient>
}

export interface ClaveApiClient {
  readonly url: string
  // ── Lane A ──
  readonly sessions: SessionsClient
  readonly clients: ClientsClient
  // ── Lane D ──
  readonly settings: SettingsClient
  // ── Lane C: the sidebar (`./sidebar.ts`) ──
  readonly sidebar: SidebarClient
  // ── Wave 3, lane A: the workspace files (`./workspace-files.ts`) ──
  readonly workspaceFiles: WorkspaceFilesClient
  // ── Lane B: terminals ──
  readonly health: {
    readonly live: () => Promise<boolean>
  }
  readonly dispose: () => Promise<void>
}

/** Network failures and refusals become the two errors above; a declared
 *  business failure (a `SessionNotFound`, a `CapabilityUnavailable`) is
 *  thrown as the tagged error it is, with its fields and its `_tag`. A
 *  refusal arrives decoded as the API's own problem class (every endpoint
 *  declares them), not as a raw status. */
const translate = (url: string, error: unknown): Error => {
  if (HttpClientError.isHttpClientError(error) && error._tag === 'RequestError')
    return new ServerUnreachable(url, error)
  if (Schema.is(UnauthorizedProblem)(error)) return new ServerRefused(url, 401)
  if (Schema.is(ForbiddenProblem)(error)) return new ServerRefused(url, 403)
  if (error instanceof Error) return error
  return new Error(String(error))
}

/** Five minutes of review plus half a minute for the answer to travel. */
export const PATIENT_TIMEOUT_MS = 5 * 60 * 1000 + 30_000

export function createApiClient(options: ApiClientOptions): ClaveApiClient {
  const runtime = ManagedRuntime.make(options.httpClient ?? FetchHttpClient.layer)
  const derived = (timeout: number): Promise<DerivedClient> =>
    runtime.runPromise(
      deriveClient({
        baseUrl: options.url,
        bearer: () => options.token,
        timeout,
        // One attempt: a command retried blindly runs twice, and a server that
        // does not answer is something the caller must hear about at once.
        retry: { attempts: 1 }
      })
    )
  const client = derived(options.timeoutMs ?? 10_000)
  // The same client under the patient deadline, for the calls the server may
  // hold on purpose (`workspace-files.ts`). Derived once, lazily.
  let patientClient: Promise<DerivedClient> | null = null
  const callOn =
    (clientOf: () => Promise<DerivedClient>): Call =>
    async (run) => {
      const c = await clientOf()
      const result = await runtime.runPromise(Effect.either(run(c)))
      if (Either.isLeft(result)) throw translate(options.url, result.left)
      return result.right
    }
  const call = callOn(() => client)
  const patientCall = callOn(
    () => (patientClient ??= derived(options.patientTimeoutMs ?? PATIENT_TIMEOUT_MS))
  )
  return {
    url: options.url,
    sessions: sessionsClient(call),
    clients: clientsClient(call),
    settings: settingsClient(call),
    sidebar: sidebarClient(call),
    workspaceFiles: workspaceFilesClient(call, patientCall),
    health: {
      live: () => call((c) => c.health.live()).then((answer) => answer.status === 'live')
    },
    dispose: () => runtime.dispose()
  }
}
