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

export interface ApiClientOptions {
  readonly url: string
  readonly token: string
  /** Per-request deadline. Default: 10 seconds. */
  readonly timeoutMs?: number
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

export function createApiClient(options: ApiClientOptions): ClaveApiClient {
  const runtime = ManagedRuntime.make(options.httpClient ?? FetchHttpClient.layer)
  const derive = deriveClient({
    baseUrl: options.url,
    bearer: () => options.token,
    timeout: options.timeoutMs ?? 10_000,
    // One attempt: a command retried blindly runs twice, and a server that
    // does not answer is something the caller must hear about at once.
    retry: { attempts: 1 }
  })
  const client: Promise<DerivedClient> = runtime.runPromise(derive)
  const call: Call = async (run) => {
    const c = await client
    const result = await runtime.runPromise(Effect.either(run(c)))
    if (Either.isLeft(result)) throw translate(options.url, result.left)
    return result.right
  }
  return {
    url: options.url,
    sessions: sessionsClient(call),
    clients: clientsClient(call),
    settings: settingsClient(call),
    sidebar: sidebarClient(call),
    health: {
      live: () => call((c) => c.health.live()).then((answer) => answer.status === 'live')
    },
    dispose: () => runtime.dispose()
  }
}
