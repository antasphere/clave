/**
 * The agent tools' client of Clave's server (wave 3, PRDCT-3294). The MCP
 * server runs in Electron main and reaches the server the way a window does:
 * through the typed client, over HTTP on the loopback, with the address main
 * itself published (`server/endpoint.ts`, set when the in-process server
 * starts or an attached one is reached). The client, and Effect under it,
 * load on the first tool call that needs them, never at boot
 * (`server/lazy-load.test.ts`), and a tool call that lands before the boot
 * has named a server waits for the decision rather than failing on the race,
 * and fails at once once the boot has decided there is none.
 *
 * Its requests go out through `@effect/platform-node`'s HTTP client, as the
 * preload's do, and its deadline is the longest a view request may wait plus
 * a margin: a request to a window waits on the person, not on the network.
 */
import type { ClaveApiClient } from '@clave/client'
import { VIEW_REQUEST_MAX_TIMEOUT_MS } from '@clave/contract/view-deadlines'
import {
  type ClaveServerEndpoint,
  getClaveServerEndpoint,
  isClaveServerBootSettled
} from '../server/endpoint'

export interface ServerClientOptions {
  /** Where the server is, null while the boot has not named one. */
  readonly endpoint?: () => ClaveServerEndpoint | null
  /** Whether the boot has decided (a server named, or none): with no
   *  endpoint once it has, a call fails at once instead of waiting. */
  readonly settled?: () => boolean
  /** Builds the client for an endpoint; the real one loads `@clave/client`. */
  readonly connect?: (endpoint: ClaveServerEndpoint) => Promise<ClaveApiClient>
  /** How long a call waits for the boot to name a server. */
  readonly waitMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface ServerClient {
  /** The client on the server the shell runs or reached; rebuilt when the
   *  address changes. Rejects when no server is named within `waitMs`. */
  readonly api: () => Promise<ClaveApiClient>
}

export const NO_SERVER_MESSAGE =
  "Clave's server is not running: the agent tools need it. Restart Clave, or check the log for why the server did not start."

const defaultConnect = async (endpoint: ClaveServerEndpoint): Promise<ClaveApiClient> => {
  const [{ createApiClient }, { layer }] = await Promise.all([
    import('@clave/client'),
    import('@effect/platform-node/NodeHttpClient')
  ])
  return createApiClient({
    url: endpoint.url,
    token: endpoint.token,
    httpClient: layer,
    timeoutMs: VIEW_REQUEST_MAX_TIMEOUT_MS + 5_000
  })
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function createServerClient(options: ServerClientOptions = {}): ServerClient {
  const endpointOf = options.endpoint ?? getClaveServerEndpoint
  const settled = options.settled ?? isClaveServerBootSettled
  const connect = options.connect ?? defaultConnect
  const waitMs = options.waitMs ?? 15_000
  const sleep = options.sleep ?? defaultSleep
  let current: { endpoint: ClaveServerEndpoint; client: Promise<ClaveApiClient> } | null = null

  const awaitEndpoint = async (): Promise<ClaveServerEndpoint> => {
    const deadline = Date.now() + waitMs
    for (;;) {
      const endpoint = endpointOf()
      if (endpoint) return endpoint
      // The boot decided there is no server: nothing to wait for.
      if (settled() || Date.now() >= deadline) throw new Error(NO_SERVER_MESSAGE)
      await sleep(100)
    }
  }

  return {
    api: async () => {
      const endpoint = await awaitEndpoint()
      if (
        current &&
        current.endpoint.url === endpoint.url &&
        current.endpoint.token === endpoint.token
      )
        return current.client
      const previous = current
      const client = connect(endpoint)
      current = { endpoint, client }
      // A client built for an address that is gone is let go of; a failure
      // to build this one is the caller's to see, and the next call tries again.
      void previous?.client.then((old) => old.dispose()).catch(() => undefined)
      client.catch(() => {
        if (current?.client === client) current = null
      })
      return client
    }
  }
}

/** The app's own client, on the server main published. */
export const serverClient: ServerClient = createServerClient()
