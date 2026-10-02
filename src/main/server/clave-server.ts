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
 */
import { ENV_SERVER_TOKEN, ENV_SERVER_URL } from '@clave/contract'
import type { SessionInput } from '../../shared/session-model'
import { type EmbeddedServer, type SessionSourceService, startEmbedded } from '@clave/server'
import { type SessionManager, sessionManager } from '../sessions/session-manager'

export interface ClaveServerEndpoint {
  url: string
  token: string
}

let running: EmbeddedServer | null = null
let endpoint: ClaveServerEndpoint | null = null
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

/** Start the server once; a second call answers the running one's address. */
export async function startClaveServer(
  options: {
    port?: number
    token?: string
    manager?: SessionManager
    env?: NodeJS.ProcessEnv
  } = {}
): Promise<ClaveServerEndpoint> {
  if (running && endpoint) return endpoint
  const manager = options.manager ?? sessionManager
  const server = await startEmbedded({
    sessions: sessionSourceFromManager(manager),
    ...(options.port !== undefined && { port: options.port }),
    ...(options.token !== undefined && { token: options.token })
  })
  running = server
  endpoint = { url: server.url, token: server.token }
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

export function getClaveServerEndpoint(): ClaveServerEndpoint | null {
  return endpoint
}

export async function stopClaveServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = running
  running = null
  endpoint = null
  stopStates?.()
  stopStates = null
  delete env[ENV_SERVER_URL]
  delete env[ENV_SERVER_TOKEN]
  await server?.stop()
}
