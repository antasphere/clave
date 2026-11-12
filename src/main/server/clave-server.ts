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
import { hostname } from 'node:os'
import { type OwnServerName, ownServerName as keptServerName } from './server-name'
import type { EmbeddedServer, ServerPorts } from '@clave/server'
import { type SessionManager, sessionManager } from '../sessions/session-manager'
import {
  type ClaveServerEndpoint,
  getClaveServerEndpoint,
  setClaveServerEndpoint
} from './endpoint'
import {
  observeSessionWrites,
  publishSessionStates,
  setServerEventPublisher
} from './session-events'

export { type ClaveServerEndpoint, getClaveServerEndpoint } from './endpoint'

let running: EmbeddedServer | null = null
let starting: Promise<ClaveServerEndpoint> | null = null
let stopStates: (() => void) | null = null
// ── The mobile wave, lane B: the write ledger's evidence, while the server runs ──
let stopWrites: (() => void) | null = null

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
  /** Where this Mac keeps the name it answers to as a server (PRDCT-4241):
   *  the app's user data. Absent (tests), the name is the environment's or
   *  the hostname's and cannot be set. */
  dataDir?: string
  /** The sessions this Mac keeps records of, read without pruning anything
   *  (PRDCT-4448): the write ledger's first activation seeds them, and asks
   *  at that activation alone. The app's terminal manager by default. */
  recordedSessionIds?: () => ReadonlyArray<string>
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
  if (options.dataDir) configureOwnServerName(options.dataDir)
  const { startEmbedded, ServerInfoPort, fileWriteLedgerStorage } = await import('@clave/server')
  // PRDCT-4327: the digests a client of this server asks for, read on this
  // process's own record of the session and filed in its own data folder.
  // PRDCT-4411: its speech, with this process's ElevenLabs key and voice.
  const [{ hostDigests, sessionLaunchOf }, { ptyManager }, { hostSpeech }] = await Promise.all([
    import('../exchange-digest'),
    import('../pty-manager'),
    import('../speech')
  ])
  // ── Mobile wave, lane A: the devices port, the shell's own Antasphere login as the owner ──
  // Loaded beside the server package (a dynamic import, so this seam stays as
  // light as it was at main's boot) and under Electron alone (the unit tests
  // of this file run without it); a boot that named its own port keeps it.
  const devices =
    ports.devices ??
    (process.versions.electron
      ? (await import('./devices-shell')).shellDevicesPort(options.appVersion)
      : undefined)
  const server = await startEmbedded({
    ports: {
      digests: hostDigests(sessionLaunchOf(ptyManager)),
      // ── Mobile wave, lane A: the devices ──
      ...(devices && { devices }),
      // ── The mobile wave, lane B: the write ledger, per session, under the user data ──
      ...(options.dataDir !== undefined && {
        writeLedger: fileWriteLedgerStorage(`${options.dataDir}/write-ledger`, {
          activationFile: `${options.dataDir}/write-ledger-activation.json`,
          // Read at the first activation alone, and never through the adoptable
          // listing, which prunes the records it cannot bring back (PRDCT-4448).
          sessionIds: () => [
            ...manager.list().map((session) => session.id),
            ...(options.recordedSessionIds ?? (() => ptyManager.recordedSessionIds()))()
          ]
        })
      }),
      speech: hostSpeech(sessionLaunchOf(ptyManager)),
      ...(options.appVersion !== undefined && {
        serverInfo: ServerInfoPort.appRun(
          options.appVersion,
          () => ownServerName(),
          options.dataDir ? (name) => setOwnServerName(name) : undefined
        )
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
  // ── The mobile wave, lane B: an identified message passing is the ledger's evidence ──
  stopWrites = observeSessionWrites(manager, server.writes.evidence, server.writes.initialize)
  return endpoint
}

/** The in-process server's id while it runs (PRDCT-4149): what a routine's
 *  `server` field may name this Mac by, beside its own name. */
export function claveServerId(): string | null {
  return running?.serverId ?? null
}

let kept: OwnServerName | null = null
const sources = (): { env: string | null; hostname: string } => ({
  env: process.env.CLAVE_SERVER_NAME ?? null,
  hostname: hostname()
})

/** Where this Mac keeps the name it answers to as a server; set once at boot. */
export function configureOwnServerName(dataDir: string): void {
  kept = keptServerName(dataDir, sources())
}

/** This Mac's own name as a server (PRDCT-4149, PRDCT-4241): the one stored
 *  from Settings when there is one, else the environment's when the harness
 *  gives one, else the first label of the machine's hostname. */
export function ownServerName(): string {
  if (kept) return kept()
  const { env, hostname: host } = sources()
  return env?.trim() || defaultServerName(host)
}

/** The name set from Settings, stored under the app's data; answers the name now in force. */
export function setOwnServerName(name: string): string {
  if (!kept) throw new Error('This Mac keeps no server name of its own in this process')
  const next = kept.set(name)
  for (const listener of [...nameListeners]) listener(next)
  return next
}

const nameListeners = new Set<(name: string) => void>()
/** Told each time this Mac's own name changes (PRDCT-4241): the routines
 *  re-read their placements against the new name. */
export function onOwnServerNameChanged(listener: (name: string) => void): () => void {
  nameListeners.add(listener)
  return () => nameListeners.delete(listener)
}

function defaultServerName(host: string): string {
  return host.trim().split('.')[0]?.trim() || 'clave-server'
}

export async function stopClaveServer(): Promise<void> {
  if (starting) await starting.catch(() => undefined)
  const server = running
  running = null
  setClaveServerEndpoint(null)
  setServerEventPublisher(null)
  stopStates?.()
  stopStates = null
  stopWrites?.()
  stopWrites = null
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
