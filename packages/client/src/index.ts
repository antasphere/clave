/**
 * `@clave/client`: the typed client of Clave's server. Requests through
 * `createApiClient` (over `@structure-ai/client`, from the shared API type),
 * subscriptions through `PushClient` (the push channel, reconnecting), and
 * `createMethodRouter` for a preload that moves methods to the server one at
 * a time. `createClaveClient` makes the pair from one endpoint.
 */
import { type ApiClientOptions, type ClaveApiClient, createApiClient } from './api'
import { PushClient, type PushClientOptions } from './push-client'

export { createApiClient, type ApiClientOptions, type ClaveApiClient } from './api'
// ── Lane A ──
export { type SessionsClient, type StartSessionInput } from './sessions'
export { type ClientsClient, type RegisterClientInput } from './clients'
// ── Lane B: terminals · Lane C: sidebar · Lane D: settings ──
export {
  PushClient,
  pushUrlOf,
  type PushClientOptions,
  type PushSocketConstructor,
  type PushSocketLike,
  type PushStatus,
  type PushStatusDetail,
  type Unsubscribe
} from './push-client'
export { ServerRefused, ServerUnreachable } from './errors'
export {
  createMethodRouter,
  type Backing,
  type Endpoint,
  type MethodRoute,
  type MethodRouter,
  type MethodRouterOptions
} from './router'

export interface ClaveClientOptions extends ApiClientOptions {
  readonly WebSocket?: PushClientOptions['WebSocket']
  readonly client?: string
  readonly backoff?: PushClientOptions['backoff']
}

export interface ClaveClient {
  readonly api: ClaveApiClient
  readonly push: PushClient
  readonly close: () => Promise<void>
}

/** The request client and a connected push client on one endpoint. */
export function createClaveClient(options: ClaveClientOptions): ClaveClient {
  const api = createApiClient(options)
  const push = new PushClient({
    url: options.url,
    token: options.token,
    ...(options.WebSocket && { WebSocket: options.WebSocket }),
    ...(options.client && { client: options.client }),
    ...(options.backoff && { backoff: options.backoff })
  }).connect()
  return {
    api,
    push,
    close: async () => {
      push.close()
      await api.dispose()
    }
  }
}
