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
import {
  observeSessionsForNotify,
  publishSessionStates,
  setServerEventPublisher
} from './session-events'
// ── The mobile wave, lane B: the fake push's hooks for the suite ──
import { installE2eHooks } from '../sessions/e2e-hooks'

export { type ClaveServerEndpoint, getClaveServerEndpoint } from './endpoint'

let running: EmbeddedServer | null = null
let starting: Promise<ClaveServerEndpoint> | null = null
let stopStates: (() => void) | null = null
// ── The mobile wave, lane B ──
let stopNotify: (() => void) | null = null
let closePush: (() => void) | null = null

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
  /** The app's version (issue #266): the server reports it and says it
   *  updates with the app (`ServerInfoPort.appRun`), built here, after the
   *  server package has loaded. */
  appVersion?: string
  /** The mobile wave, lane B: the directory the push credentials are read
   *  under (`push/apns.json`, `push/fcm-service-account.json`), the app's
   *  user data. Absent, no credential is read; `--push-fake` still puts the
   *  recording fake in place. */
  dataDir?: string
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
  const { startEmbedded, ServerInfoPort, loadPushPorts, fileWriteLedgerStorage } =
    await import('@clave/server')
  // ── The mobile wave, lane B: the push credentials under the user data, the fake under --push-fake ──
  const pushFake = process.argv.includes('--push-fake')
  const push =
    options.dataDir !== undefined || pushFake
      ? loadPushPorts({
          dataDir: options.dataDir ?? '',
          fake: pushFake,
          log: (line) => console.log(`[server] ${line}`)
        })
      : null
  if (push?.hooks) installE2eHooks({ notify: push.hooks })
  closePush = push?.close ?? null
  // ── Mobile wave, lane A: the devices port, the shell's own Antasphere login as the owner ──
  // Loaded beside the server package (a dynamic import, so this seam stays as
  // light as it was at main's boot) and under Electron alone (the unit tests
  // of this file run without it); a boot that named its own port keeps it.
  const devices =
    ports.devices ??
    (process.versions.electron ? (await import('./devices-shell')).shellDevicesPort() : undefined)
  const server = await startEmbedded({
    ports: {
      ...(options.appVersion !== undefined && {
        serverInfo: ServerInfoPort.appRun(options.appVersion)
      }),
      // ── Mobile wave, lane A: the devices ──
      ...(devices && { devices }),
      ...push?.ports,
      // ── The mobile wave, lane B: the write ledger, per session, under the user data ──
      ...(options.dataDir !== undefined && {
        writeLedger: fileWriteLedgerStorage(`${options.dataDir}/write-ledger`)
      }),
      ...ports
    },
    ...(options.port !== undefined && { port: options.port }),
    ...(options.token !== undefined && { token: options.token }),
    ...(options.testFixtures !== undefined && { testFixtures: options.testFixtures })
  })
  running = server
  const endpoint: ClaveServerEndpoint = { url: server.url, token: server.token, mode: 'in-process' }
  setClaveServerEndpoint(endpoint)
  setServerEventPublisher((event) => server.publish(event))
  stopStates = publishSessionStates(manager, (event) => server.publish(event))
  // ── The mobile wave, lane B: the sessions' frames and exits reach the notifier ──
  stopNotify = observeSessionsForNotify(manager, server.notify, server.writes.evidence)
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
  // ── The mobile wave, lane B: nothing is pushed for what a quit ends ──
  stopNotify?.()
  stopNotify = null
  closePush?.()
  closePush = null
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
