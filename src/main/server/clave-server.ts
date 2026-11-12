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
import { join } from 'node:path'
import { type OwnServerName, ownServerName as keptServerName } from './server-name'
import type { EmbeddedServer, ServerPorts } from '@clave/server'
import type { ForwardRegistry } from '@clave/server/forward-registry'
import type { ArtefactServiceHandle } from '../artefacts/service'
import { type SessionManager, sessionManager } from '../sessions/session-manager'
import {
  type ClaveServerEndpoint,
  getClaveServerEndpoint,
  setClaveServerEndpoint
} from './endpoint'
import { publishSessionStates, setServerEventPublisher } from './session-events'

export { type ClaveServerEndpoint, getClaveServerEndpoint } from './endpoint'

let running: EmbeddedServer | null = null
/** PRDCT-4472: the artefacts of this server's sessions, stopped with it. */
let artefactService: { stop(): Promise<void> } | null = null
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
  /** The app's version (issue #266): the server reports it and says it
   *  updates with the app (`ServerInfoPort.appRun`), built here, after the
   *  server package has loaded. */
  appVersion?: string
  /** Where this Mac keeps the name it answers to as a server (PRDCT-4241):
   *  the app's user data. Absent (tests), the name is the environment's or
   *  the hostname's and cannot be set. */
  dataDir?: string
  /** PRDCT-4472: the artefacts of this server's sessions, over the app's user
   *  data (so the copy of Slideless the app installed under `slideless/cli`
   *  is the one it runs); `autoInstall` off under test mode with no fixture
   *  registry. Absent, the server shows no artefacts. */
  artefacts?: { readonly dataDir: string; readonly autoInstall: boolean }
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
  const { startEmbedded, ServerInfoPort } = await import('@clave/server')
  // PRDCT-4327: the digests a client of this server asks for, read on this
  // process's own record of the session and filed in its own data folder.
  // PRDCT-4411: its speech, with this process's ElevenLabs key and voice.
  const [{ hostDigests, sessionLaunchOf }, { ptyManager }, { hostSpeech }] = await Promise.all([
    import('../exchange-digest'),
    import('../pty-manager'),
    import('../speech')
  ])
  // PRDCT-4472: a session's HTML artefact, its preview and its versions, this
  // process's own; a preview a window holds is reached through the forwarder.
  const artefacts = options.artefacts
    ? await inProcessArtefacts(options.artefacts, manager, sessionLaunchOf(ptyManager))
    : undefined
  const server = await startEmbedded({
    ports: {
      digests: hostDigests(sessionLaunchOf(ptyManager)),
      speech: hostSpeech(sessionLaunchOf(ptyManager)),
      ...(artefacts && { artefacts: artefacts.service, forwards: artefacts.forwards }),
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
  if (artefacts) {
    artefacts.service.start()
    artefactService = artefacts.service
  }
  const endpoint: ClaveServerEndpoint = { url: server.url, token: server.token, mode: 'in-process' }
  setClaveServerEndpoint(endpoint)
  setServerEventPublisher((event) => server.publish(event))
  stopStates = publishSessionStates(manager, (event) => server.publish(event))
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

/** The artefact service of the server in this process (PRDCT-4472), built
 *  only when the server runs here: a child or an attached server has its own. */
async function inProcessArtefacts(
  options: { readonly dataDir: string; readonly autoInstall: boolean },
  manager: SessionManager,
  recordOf: (sessionId: string) => unknown
): Promise<{ service: ArtefactServiceHandle; forwards: ForwardRegistry }> {
  const [{ createArtefactService }, { ArtefactLinks, fileLinksStorage }, { ForwardRegistry }] =
    await Promise.all([
      import('../artefacts/service'),
      import('../artefacts/links'),
      import('@clave/server/forward-registry')
    ])
  const forwards = new ForwardRegistry()
  const service = createArtefactService({
    dataDir: options.dataDir,
    execPath: process.execPath,
    env: process.env,
    links: new ArtefactLinks(fileLinksStorage(join(options.dataDir, 'artefacts.json'))),
    forwards,
    sessions: {
      knows: (id) => Boolean(recordOf(id)),
      // Read as `publishSessionStates` reads it (`session-events.ts`).
      onState: (listener) =>
        manager.subscribeAll((id, stream) => {
          if (stream.kind !== 'event' || stream.event.type !== 'state_change') return
          listener(id, stream.event.state)
        })
    },
    autoInstall: options.autoInstall
  })
  return { service, forwards }
}

export async function stopClaveServer(): Promise<void> {
  if (starting) await starting.catch(() => undefined)
  const server = running
  running = null
  setClaveServerEndpoint(null)
  setServerEventPublisher(null)
  stopStates?.()
  stopStates = null
  const artefacts = artefactService
  artefactService = null
  await artefacts?.stop()
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
