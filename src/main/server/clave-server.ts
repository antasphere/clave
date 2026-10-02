/**
 * The server inside the app. In this wave Clave's server (`@clave/server`,
 * on `@structure-ai`) runs in-process: Electron main starts it here at boot
 * (lane F wires the call in `src/main/index.ts`), on loopback with a fresh
 * token, and the sessions it answers for are the session manager's own,
 * through the `SessionSource` port. The address reaches the preload over
 * `server:endpoint` (`ipc-handlers/server-handlers.ts`) and any process the
 * shell spawns through the environment (`CLAVE_SERVER_URL`,
 * `CLAVE_SERVER_TOKEN`). The strangler shape of the spec: the same package
 * later runs as its own process and nothing a client sees changes.
 *
 * The server package, and Effect and the framework under it, load on the
 * first start, never when main boots: this file imports only types from it.
 */
import { ENV_SERVER_TOKEN, ENV_SERVER_URL } from '@clave/contract/env'
import type { EmbeddedServer, SessionSourceService } from '@clave/server'
import type { SessionInput } from '../../shared/session-model'
import { type SessionManager, sessionManager } from '../sessions/session-manager'
import {
  type ClaveServerEndpoint,
  getClaveServerEndpoint,
  setClaveServerEndpoint
} from './endpoint'

export { type ClaveServerEndpoint, getClaveServerEndpoint } from './endpoint'

let running: EmbeddedServer | null = null
let starting: Promise<ClaveServerEndpoint> | null = null
let stopStates: (() => void) | null = null

/**
 * The session manager as the server's session source. A write that comes in
 * over the wire reaches the manager as written, minus `prepared`: that field
 * is main's to build from attachment records (`sessions/ipc.ts`), never a
 * caller's to supply, and the server's write path does not prepare
 * attachments yet. The lane that moves sessions onto the server brings that
 * preparation with it.
 */
export function sessionSourceFromManager(manager: SessionManager): SessionSourceService {
  return {
    list: (windowKey) => manager.list(windowKey),
    get: (id) => manager.get(id),
    subscribe: (id, listener) => manager.subscribe(id, listener),
    subscribeExit: (id, listener) => manager.subscribeExit(id, listener),
    write: (id, input) => {
      if (input.type === 'bytes') return manager.write(id, input.data)
      const message =
        input.type === 'user_message'
          ? {
              type: input.type,
              text: input.text,
              ...(input.attachments && { attachments: input.attachments })
            }
          : input
      // The contract's types are readonly, the renderer's zod types are not;
      // the shapes are the same, the test beside this file holds them so.
      return manager.write(id, message as SessionInput)
    }
  }
}

export interface StartOptions {
  port?: number
  token?: string
  manager?: SessionManager
  env?: NodeJS.ProcessEnv
}

/** Start the server once; a second call, concurrent or later, answers the
 *  same address. */
export function startClaveServer(options: StartOptions = {}): Promise<ClaveServerEndpoint> {
  const current = getClaveServerEndpoint()
  if (running && current) return Promise.resolve(current)
  if (!starting) {
    starting = start(options).finally(() => {
      starting = null
    })
  }
  return starting
}

async function start(options: StartOptions): Promise<ClaveServerEndpoint> {
  const manager = options.manager ?? sessionManager
  const { startEmbedded } = await import('@clave/server')
  const server = await startEmbedded({
    sessions: sessionSourceFromManager(manager),
    ...(options.port !== undefined && { port: options.port }),
    ...(options.token !== undefined && { token: options.token })
  })
  running = server
  const endpoint: ClaveServerEndpoint = { url: server.url, token: server.token }
  setClaveServerEndpoint(endpoint)
  const env = options.env ?? process.env
  env[ENV_SERVER_URL] = server.url
  env[ENV_SERVER_TOKEN] = server.token
  // Every attached client hears a session change state, whether or not it
  // follows that session's stream.
  stopStates = manager.subscribeAll((id, stream) => {
    if (stream.kind !== 'event' || stream.event.type !== 'state_change') return
    void server
      .publish({ _tag: 'session.state_changed', id, state: stream.event.state })
      .catch((error) => console.error('[clave-server] state event not published', error))
  })
  return endpoint
}

export async function stopClaveServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (starting) await starting.catch(() => undefined)
  const server = running
  running = null
  setClaveServerEndpoint(null)
  stopStates?.()
  stopStates = null
  delete env[ENV_SERVER_URL]
  delete env[ENV_SERVER_TOKEN]
  await server?.stop()
}
