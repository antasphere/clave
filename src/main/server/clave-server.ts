/**
 * The server inside the app. Clave's server (`@clave/server`, on
 * `@structure-ai`) runs in-process: Electron main starts it here at boot
 * (`src/main/index.ts` through `server-boot.ts`), on loopback with a fresh
 * token, and the sessions it answers for are the shell's own, through the
 * session host (`sessions/host.ts`, the `SessionHost` port). The address
 * reaches the preload over IPC (`ipc-handlers/server-handlers.ts`) and
 * nothing else: it is never written into main's own environment, so no
 * process the shell spawns inherits it (the wave's ruling of 2 October 2026;
 * a Clave started from a Clave tab would otherwise reach the outer server).
 * The strangler shape of the spec: the same package later runs as its own
 * process and nothing a client sees changes.
 *
 * The pattern, per domain: the shell's implementation of the domain's port
 * is one entry in the `ports` the boot passes (`src/main/index.ts`:
 * `sessions/host.ts` for the sessions); a lane adds its own there and edits
 * nothing here. The ports are required, not defaulted: a server started with
 * none would answer every start with "no sessions" and look like a server.
 *
 * The server package, and Effect and the framework under it, load on the
 * first start, never when main boots: this file imports only types from it,
 * and nothing of the session host's graph (the PTY backend and its native
 * modules), which the boot owns.
 */
import type { EmbeddedServer, ServerPorts } from '@clave/server'
import { type SessionManager, sessionManager } from '../sessions/session-manager'
import {
  type ClaveServerEndpoint,
  getClaveServerEndpoint,
  setClaveServerEndpoint
} from './endpoint'
import { publishSessionStates, setServerEventPublisher } from './session-events'

export { type ClaveServerEndpoint, getClaveServerEndpoint } from './endpoint'

let running: EmbeddedServer | null = null
let starting: Promise<ClaveServerEndpoint> | null = null
let stopStates: (() => void) | null = null

export interface StartOptions {
  port?: number
  token?: string
  /** The manager whose state changes are published; the app's by default. */
  manager?: SessionManager
  /** The ports the server answers from, one per domain (`ports.ts`). */
  ports: ServerPorts
  /** The end-to-end fixture route, under `--test-no-activate` only (lane C
   *  of wave 3): the boot passes the test flag, nothing else turns it on. */
  testFixtures?: boolean
}

/** Start the server once; a second call, concurrent or later, answers the
 *  same address. */
export function startClaveServer(options: StartOptions): Promise<ClaveServerEndpoint> {
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
  const { ports } = options
  const { startEmbedded } = await import('@clave/server')
  const server = await startEmbedded({
    ports,
    ...(options.port !== undefined && { port: options.port }),
    ...(options.token !== undefined && { token: options.token }),
    ...(options.testFixtures !== undefined && { testFixtures: options.testFixtures })
  })
  running = server
  const endpoint: ClaveServerEndpoint = { url: server.url, token: server.token, mode: 'in-process' }
  setClaveServerEndpoint(endpoint)
  setServerEventPublisher((event) => server.publish(event))
  stopStates = publishSessionStates(manager, (event) => server.publish(event))
  return endpoint
}

export async function stopClaveServer(): Promise<void> {
  if (starting) await starting.catch(() => undefined)
  const server = running
  running = null
  setClaveServerEndpoint(null)
  setServerEventPublisher(null)
  stopStates?.()
  stopStates = null
  if (!server) return
  // The stop's own figures, in the log (PRDCT-3375): what it answered, who it
  // told, what it had to destroy. A quit measured at ten seconds in wave 3
  // was this stop waiting on the window's connections; the line says so now.
  const report = await server.stop()
  console.log(
    `[server] stopped in ${report.ms} ms: ${report.inFlight} request(s) in flight` +
      `${report.drained ? '' : ', NOT all answered'}, ${report.peers} push peer(s) closed, ` +
      `${report.destroyed} connection(s) destroyed`
  )
}
