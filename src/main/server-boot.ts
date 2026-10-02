/**
 * How the Electron shell gets its server (ADR 0003, PRDCT-3154).
 *
 * Two ways, decided by the environment the app was launched with:
 *
 *  - IN-PROCESS (the default, what the shipped app does): the server starts
 *    inside Electron main on a loopback port with a fresh token. Today that is
 *    the stub in `server-stub.ts`; once lane A's `packages/server` merges it is
 *    that package, and nothing else in this file changes.
 *  - ATTACHED (`CLAVE_SERVER_URL`, with `CLAVE_SERVER_TOKEN`): the app uses a
 *    server somebody else started, the standalone entry under Bun (`npm run
 *    dev:attached`, or the e2e harness, one server per spec).
 *
 * Either way the shell then REGISTERS itself with the server (`POST /clients`,
 * its pid and version), so the server knows which app is on it, and writes
 * `clave-server.json` in the user-data directory: the url, the token, the mode
 * and whether it worked, the discovery file the harness reads, after the shape
 * of `mcp-server.json`.
 *
 * An attach that fails (nothing answers the url, or the token is refused) is
 * NEVER papered over by starting the in-process server instead. The user, or
 * the harness, asked for that server; silently running another would hide the
 * misconfiguration and make an "attached" test run pass on an in-process
 * server. The app runs without a server, the failure is in the log and in the
 * discovery file, and the caller is told so it can say so on screen.
 *
 * Nothing here imports Electron: the paths and the identity come in as
 * arguments, and the module is unit-tested with fakes.
 */
import * as fs from 'fs'
import * as path from 'path'

export type ServerMode = 'in-process' | 'attached'

/** A server the shell can use: where it is and how to let go of it. */
export interface ServerHandle {
  url: string
  token: string
  mode: ServerMode
  /** The id the server gave this app on registration. */
  clientId: string | null
  /** Deregister, and stop the server when it is ours. Idempotent. */
  stop: () => Promise<void>
}

/** What the shell says about itself when it registers. */
export interface ShellIdentity {
  kind: 'electron'
  pid: number
  version: string
}

/** What `clave-server.json` carries. `ok: false` is an attach that failed. */
export interface ServerDiscovery {
  url: string
  token: string | null
  mode: ServerMode
  ok: boolean
  error?: string
  pid: number
  clientId: string | null
}

export const DISCOVERY_FILE = 'clave-server.json'

export type ServerLaunch =
  | { mode: 'in-process' }
  | { mode: 'attached'; url: string; token: string | null }

/** Read the launch decision off the environment. Pure. */
export function resolveServerLaunch(env: NodeJS.ProcessEnv): ServerLaunch {
  const url = env.CLAVE_SERVER_URL?.trim()
  if (!url) return { mode: 'in-process' }
  const token = env.CLAVE_SERVER_TOKEN?.trim()
  return { mode: 'attached', url: url.replace(/\/+$/, ''), token: token || null }
}

export interface InProcessServer {
  url: string
  token: string
  stop: () => Promise<void>
}

export interface StartServerOptions {
  env: NodeJS.ProcessEnv
  /** The user-data directory the discovery file is written into. */
  userData: string
  identity: ShellIdentity
  /** Starts the in-process server. Injected so the boot is testable and so the
   *  swap to lane A's package is one argument at the call site. */
  startInProcess: () => Promise<InProcessServer>
  /** `fetch`, injectable for the tests. */
  fetch?: typeof fetch
  /** How long one call to the server may take. */
  timeoutMs?: number
}

export class ServerBootError extends Error {
  constructor(
    message: string,
    public readonly mode: ServerMode,
    public readonly url: string
  ) {
    super(message)
    this.name = 'ServerBootError'
  }
}

/** Write-then-rename, mode 0600: the file carries the token. */
export function writeDiscovery(userData: string, discovery: ServerDiscovery): void {
  fs.mkdirSync(userData, { recursive: true })
  const file = path.join(userData, DISCOVERY_FILE)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(discovery, null, 2), { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, file)
  fs.chmodSync(file, 0o600)
}

export function readDiscovery(userData: string): ServerDiscovery | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, DISCOVERY_FILE), 'utf-8'))
  } catch {
    return null
  }
}

async function call(
  doFetch: typeof fetch,
  timeoutMs: number,
  url: string,
  init: RequestInit & { token?: string | null } = {}
): Promise<Response> {
  const { token, ...rest } = init
  const headers = new Headers(rest.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  return doFetch(url, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) })
}

/**
 * Start or attach, register, write the discovery file. Resolves with the
 * handle; REJECTS with a `ServerBootError` when the server asked for cannot
 * be used (the discovery file then says `ok: false`, and nothing was started
 * in its place).
 */
export async function startServer(options: StartServerOptions): Promise<ServerHandle> {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 5000
  const launch = resolveServerLaunch(options.env)
  const pid = options.identity.pid

  let server: InProcessServer | null = null
  let url: string
  let token: string | null
  if (launch.mode === 'attached') {
    url = launch.url
    token = launch.token
  } else {
    server = await options.startInProcess()
    url = server.url
    token = server.token
  }

  const fail = async (message: string): Promise<never> => {
    if (server) await server.stop().catch(() => {})
    writeDiscovery(options.userData, {
      url,
      token: null,
      mode: launch.mode,
      ok: false,
      error: message,
      pid,
      clientId: null
    })
    throw new ServerBootError(message, launch.mode, url)
  }

  // Is anything there? The probe needs no token, so a wrong token and a dead
  // url are told apart in the message.
  try {
    const live = await call(doFetch, timeoutMs, `${url}/health/live`)
    if (!live.ok) return fail(`${url} answered ${live.status} on /health/live`)
  } catch (err) {
    return fail(`nothing answers at ${url}: ${(err as Error).message}`)
  }

  let clientId: string | null = null
  try {
    const res = await call(doFetch, timeoutMs, `${url}/clients`, {
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options.identity)
    })
    if (res.status === 401) return fail(`${url} refused the token`)
    if (!res.ok) return fail(`${url} answered ${res.status} on POST /clients`)
    const body = (await res.json()) as { id?: unknown }
    clientId = typeof body.id === 'string' ? body.id : null
  } catch (err) {
    if (err instanceof ServerBootError) throw err
    return fail(`registering with ${url} failed: ${(err as Error).message}`)
  }

  writeDiscovery(options.userData, {
    url,
    token,
    mode: launch.mode,
    ok: true,
    pid,
    clientId
  })

  let stopped = false
  return {
    url,
    token: token ?? '',
    mode: launch.mode,
    clientId,
    stop: async () => {
      if (stopped) return
      stopped = true
      if (clientId) {
        // Best effort, bounded: a quit must not wait on a server that is gone.
        await call(doFetch, Math.min(timeoutMs, 1500), `${url}/clients/${clientId}`, {
          method: 'DELETE',
          token
        }).catch(() => {})
      }
      if (server) await server.stop()
    }
  }
}
