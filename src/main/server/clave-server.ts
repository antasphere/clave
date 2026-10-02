/**
 * The server inside the app. In this wave Clave's server (`@clave/server`,
 * on `@structure-ai`) runs in-process: Electron main starts it here at boot
 * (lane F wires the call in `src/main/index.ts`), on loopback with a fresh
 * token, and the sessions it answers for are the session manager's own,
 * through the `SessionSource` port. The address reaches the preload over
 * IPC (`ipc-handlers/server-handlers.ts`) and nothing else: it is never
 * written into main's own environment, so no process the shell spawns
 * inherits it (the wave's ruling of 2 October 2026; a Clave started from a
 * Clave tab would otherwise reach the outer server). The strangler shape of
 * the spec: the same package later runs as its own process and nothing a
 * client sees changes.
 *
 * The server package, and Effect and the framework under it, load on the
 * first start, never when main boots: this file imports only types from it.
 */
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
 * over the wire reaches the manager as the contract decoded it: the wire's
 * input union carries no `prepared` prompt (that field is main's to build
 * from attachment records, `sessions/ipc.ts`, never a caller's to supply),
 * so a smuggled one is dropped at the server's boundary before this code
 * sees it. The server's write path does not prepare attachments yet; the
 * lane that moves sessions onto the server brings that preparation with it.
 */
export function sessionSourceFromManager(manager: SessionManager): SessionSourceService {
  return {
    list: (windowKey) => manager.list(windowKey),
    get: (id) => manager.get(id),
    subscribe: (id, listener) => manager.subscribe(id, listener),
    subscribeExit: (id, listener) => manager.subscribeExit(id, listener),
    write: (id, input) =>
      // The contract's types are readonly, the renderer's zod types are not;
      // the shapes are the same, `packages/contract/src/sessions.test.ts`
      // holds the two models together.
      manager.write(id, input.type === 'bytes' ? input.data : (input as SessionInput))
  }
}

export interface StartOptions {
  port?: number
  token?: string
  manager?: SessionManager
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

export async function stopClaveServer(): Promise<void> {
  if (starting) await starting.catch(() => undefined)
  const server = running
  running = null
  setClaveServerEndpoint(null)
  stopStates?.()
  stopStates = null
  await server?.stop()
}
