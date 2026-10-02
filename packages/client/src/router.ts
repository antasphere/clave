/**
 * The method router: how the preload sends one method of `electronAPI` to
 * the server and the next one over IPC, method by method, while the renderer
 * keeps calling the same names. A method with a `server` arm goes to the
 * server once an endpoint is known; a method without one, or any method
 * before an endpoint exists, goes over IPC. Once the server is in use, its
 * failure is the caller's to see: nothing here falls back to IPC on an error.
 *
 * This module imports nothing at runtime, on purpose: it is what a preload
 * loads at window start, and the client proper comes in through `connect`.
 */
import type { ClaveApiClient } from './api'
import type { PushClient } from './push-client'

export interface Endpoint {
  readonly url: string
  readonly token: string
}

export interface Backing {
  readonly api: ClaveApiClient
  readonly push: PushClient
}

export interface MethodRoute<A extends unknown[], R> {
  readonly ipc: (...args: A) => Promise<R>
  readonly server?: (backing: Backing, ...args: A) => Promise<R>
}

export interface MethodRouterOptions {
  /** Where the server is, or null while there is none. Asked again on every
   *  routed call until it answers an endpoint; a backing, once built, is
   *  kept until `reset`. A window whose first call lands before the server
   *  is up therefore joins it on its next call, not on its next reload. */
  readonly resolve: () => Promise<Endpoint | null>
  /** Builds the backing for an endpoint; may load the client lazily, which is
   *  why it may answer a promise: a preload that imports Effect at window
   *  start pays for it on every window, needed or not. */
  readonly connect: (endpoint: Endpoint) => Backing | Promise<Backing>
}

export interface MethodRouter {
  readonly route: <A extends unknown[], R>(route: MethodRoute<A, R>) => (...args: A) => Promise<R>
  /** The backing in use, null when this call goes over IPC. */
  readonly backing: () => Promise<Backing | null>
  /** Forget the backing, so the next call asks for the endpoint again. */
  readonly reset: () => void
}

export function createMethodRouter(options: MethodRouterOptions): MethodRouter {
  let backing: Promise<Backing | null> | null = null
  const acquire = (): Promise<Backing | null> => {
    if (!backing) {
      const attempt = options
        .resolve()
        .then(
          (endpoint) => (endpoint ? options.connect(endpoint) : null),
          () => null
        )
        .then((built) => {
          // No endpoint yet, or none reachable: nothing is remembered, the
          // next call asks again.
          if (!built && backing === attempt) backing = null
          return built
        })
      backing = attempt
    }
    return backing
  }
  return {
    route:
      (route) =>
      async (...args) => {
        if (!route.server) return route.ipc(...args)
        const current = await acquire()
        return current ? route.server(current, ...args) : route.ipc(...args)
      },
    backing: acquire,
    reset: () => {
      backing = null
    }
  }
}
