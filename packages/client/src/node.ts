/**
 * The client through Node: the backing a preload builds when it runs with
 * Node available (Electron's `sandbox: false`). The request client goes out
 * through `@effect/platform-node`'s HTTP client and the push socket through
 * `ws`, so nothing of the window's origin travels: the packaged `file://`
 * page sends no `Origin`, meets no Content Security Policy and no preflight,
 * and the server's cross-origin rules stay for browser pages (ADR 0003).
 *
 * Its own module, behind `@clave/client/node`, so a browser client never
 * pulls the Node packages in, and so a preload reaches everything through
 * ONE dynamic import on first use (the lazy-load guard counts them: an eager
 * import costs every window its start).
 */
import { createApiClient } from './api'
import { PushClient, type PushSocketConstructor } from './push-client'
import type { Backing, Endpoint } from './router'

export interface NodeBackingOptions {
  /** How the client names itself in its push hello. */
  readonly client?: string
}

/** The request client and the push client for `endpoint`, both over Node.
 *  The push socket is opened by the first subscription, not here. */
export async function connectThroughNode(
  endpoint: Endpoint,
  options: NodeBackingOptions = {}
): Promise<Backing> {
  const [{ layer }, { WebSocket }] = await Promise.all([
    import('@effect/platform-node/NodeHttpClient'),
    import('ws')
  ])
  return {
    api: createApiClient({ ...endpoint, httpClient: layer }),
    push: new PushClient({
      ...endpoint,
      ...(options.client !== undefined && { client: options.client }),
      WebSocket: WebSocket as unknown as PushSocketConstructor
    })
  }
}
