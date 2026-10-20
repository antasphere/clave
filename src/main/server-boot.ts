/**
 * How the Electron shell gets its server (ADR 0003, PRDCT-3154).
 *
 * Three ways, decided by the environment and the command line the app was
 * launched with (`resolveServerLaunch`):
 *
 *  - IN-PROCESS (the default, what the shipped app does until the second
 *    pull request of PRDCT-3434 flips `PACKAGED_DEFAULT`): the server starts
 *    inside Electron main on a loopback port with a fresh token: `@clave/server`
 *    over the session manager, through `server/clave-server.ts` (lane A's),
 *    which also publishes the address to the windows over IPC.
 *  - ATTACHED (`CLAVE_SERVER_URL`, with `CLAVE_SERVER_TOKEN`): the app uses a
 *    server somebody else started, the standalone entry under Bun (`npm run
 *    dev:attached`, or the e2e harness, one server per spec). The shell
 *    registers on it and the harness proves the boot. Since wave 2 the
 *    address is published to the windows, which route to it.
 *  - SEPARATE (`--server=separate` on the command line, wave 5): the app
 *    starts the same standalone entry itself, as a child of its own, from
 *    the bundle it carries and under its own binary run as Node
 *    (`server-child.ts`), with the terminal process beside it, and then
 *    attaches to it exactly as above. A child that cannot start is said on
 *    screen and in the log, and nothing runs in its place. `--server=in-process`
 *    keeps the in-process server for development and the harness; the
 *    environment's url wins over the flag.
 *
 * Either way the shell then reserves an invisible identity and confirms it with the server
 * before publishing its presence, so the server knows which app is on it, and writes
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
import type { Client } from '@clave/contract/clients'
import * as fs from 'fs'
import * as path from 'path'
import { ENV_SERVER_URL, ENV_SERVER_TOKEN } from '@clave/contract/env'

export type ServerMode = 'in-process' | 'attached' | 'separate'

/** A server the shell can use: where it is and how to let go of it. */
export interface ServerHandle {
  url: string
  token: string
  mode: ServerMode
  /** The id the server gave this app on registration. */
  clientId: string | null
  /** The separate server's pid, when the shell started one as a child. */
  serverPid?: number
  /** Deregister, and stop the server when it is ours. Idempotent. */
  stop: () => Promise<void>
}

/** What the shell says about itself when it registers: the contract's
 *  RegisterClient payload (`packages/contract/src/clients.ts`). */
export interface ShellIdentity {
  kind: 'shell'
  /** How the client names itself (`clave-shell 2.0.0`). */
  name: string
  pid: number
}

/** What `clave-server.json` carries. `ok: false` is an attach that failed. */
export interface ServerDiscovery {
  url: string
  token: string | null
  mode: ServerMode
  ok: boolean
  error?: string
  /** The shell's own pid (the harness tells a stale file from this launch's by it). */
  pid: number
  clientId: string | null
  /** The separate server's pid, when the shell started one (wave 5). */
  serverPid?: number
}

export const DISCOVERY_FILE = 'clave-server.json'

export type ServerLaunch =
  | { mode: 'in-process' }
  | { mode: 'separate' }
  | { mode: 'attached'; url: string; token: string | null }

/** The command-line flag that picks the shell's own server: `--server=in-process`
 *  or `--server=separate` (`--server <mode>` too). */
export const SERVER_FLAG = '--server'

/** What a PACKAGED app runs with no flag given: the separate server, since
 *  the second pull request of PRDCT-3434 (wave 5, after lane C put the chat
 *  views on the separate server). A development run and the harness stay
 *  in-process whatever this says; `--server=in-process` is the way back for
 *  a packaged app (`open -a Clave --args --server=in-process`). */
export const PACKAGED_DEFAULT: 'in-process' | 'separate' = 'separate'
/** Where the packaged default applies: macOS only. The separate server's
 *  secrets live in the macOS Keychain (`ports/secrets.ts`), unavailable
 *  elsewhere, so a Windows or Linux install switched to it would lose its
 *  Claude tokens at the migration and could not seal new ones (round 4 of
 *  the verifier). Elsewhere the default stays in-process. */
export const PACKAGED_DEFAULT_PLATFORMS: readonly NodeJS.Platform[] = ['darwin']

export interface LaunchInput {
  /** The process's arguments, where `--server` is read. */
  argv?: readonly string[]
  /** Whether the app runs packaged (`app.isPackaged`): decides the default. */
  packaged?: boolean
  /** The platform (`process.platform`): the packaged default is macOS's only. */
  platform?: NodeJS.Platform
}

/** The `--server` flag's value, or undefined when the flag is absent:
 *  `--server=x` and `--server x`; a bare `--server` with nothing after it
 *  answers the empty string, which is not a mode and is refused. Given
 *  twice, the first occurrence wins. */
export function serverFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === SERVER_FLAG) return argv[i + 1] ?? ''
    if (a.startsWith(`${SERVER_FLAG}=`)) return a.slice(SERVER_FLAG.length + 1)
  }
  return undefined
}

/**
 * Read the launch decision off the environment and the command line. Pure.
 * The environment's url means attached and wins; then the flag; then the
 * default, which depends on whether the app runs packaged. A flag with a
 * value that is not a mode throws: a typo must not silently pick a mode.
 */
export function resolveServerLaunch(env: NodeJS.ProcessEnv, input: LaunchInput = {}): ServerLaunch {
  const url = env[ENV_SERVER_URL]?.trim()
  if (url) {
    const token = env[ENV_SERVER_TOKEN]?.trim()
    return { mode: 'attached', url: url.replace(/\/+$/, ''), token: token || null }
  }
  const flag = serverFlag(input.argv ?? [])
  if (flag !== undefined) {
    if (flag !== 'in-process' && flag !== 'separate')
      throw new Error(`${SERVER_FLAG} must be in-process or separate, got ${JSON.stringify(flag)}`)
    return { mode: flag }
  }
  const platform = input.platform ?? process.platform
  return {
    mode:
      input.packaged && PACKAGED_DEFAULT_PLATFORMS.includes(platform)
        ? PACKAGED_DEFAULT
        : 'in-process'
  }
}

/**
 * Read the launch decision off the environment and TAKE the two variables
 * out of it. The shell reads them once, at its own boot, and nothing it
 * spawns afterwards (sessions, git, gh, the Codex app-server, the plugin
 * runner, the login-shell probe) inherits them: the token belongs to what is
 * meant to call the server, and a Clave launched from a Clave tab must not
 * find the outer app's server in its environment. Call it before anything
 * spawns.
 */
export function takeServerLaunch(env: NodeJS.ProcessEnv, input: LaunchInput = {}): ServerLaunch {
  const launch = resolveServerLaunch(env, input)
  delete env[ENV_SERVER_URL]
  delete env[ENV_SERVER_TOKEN]
  return launch
}

/** A server the shell started itself: inside its process, or as a child. */
export interface OwnServer {
  url: string
  token: string
  /** The child's pid, when the server is a process of its own. */
  pid?: number
  /** Stop the server; what it answers (the stop's report) is the starter's to log. */
  stop: () => Promise<unknown>
}

/** The in-process server's handle; the same shape as `OwnServer`. */
export type InProcessServer = OwnServer

export interface StartServerOptions {
  /** The decision, when already taken off the environment (`takeServerLaunch`). */
  launch?: ServerLaunch
  /** The environment to read the decision from, when `launch` is not given. */
  env?: NodeJS.ProcessEnv
  /** The user-data directory the discovery file is written into. */
  userData: string
  identity: ShellIdentity
  /** Starts the in-process server. Injected so the boot is testable and so the
   *  swap to lane A's package is one argument at the call site. */
  startInProcess: () => Promise<InProcessServer>
  /** Starts the separate server as a child (`server-child.ts`), wave 5.
   *  Required when the launch says `separate`; the boot refuses otherwise. */
  startSeparate?: () => Promise<OwnServer>
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

/**
 * The server this file names is gone (the separate child exited while the
 * app runs, wave 5): the file says so, `ok: false` with the reason, the
 * token taken out, the url and the dead pid kept for the record, so a
 * reader never finds a live-looking server that is not there. Answers what
 * it wrote, or null when there was no file to mark.
 */
export function markServerGone(userData: string, reason: string): ServerDiscovery | null {
  const current = readDiscovery(userData)
  if (!current) return null
  const gone: ServerDiscovery = {
    ...current,
    token: null,
    ok: false,
    error: reason,
    clientId: null
  }
  writeDiscovery(userData, gone)
  return gone
}

/** The deadline includes response consumption, even if an adapter ignores abort. */
async function call<A>(
  doFetch: typeof fetch,
  timeoutMs: number,
  url: string,
  init: RequestInit & { token?: string | null },
  consume: (response: Response) => Promise<A>
): Promise<A> {
  if (timeoutMs <= 0) throw new DOMException('The registration deadline expired', 'TimeoutError')
  const { token, ...rest } = init
  const headers = new Headers(rest.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        const error = new DOMException('The registration deadline expired', 'TimeoutError')
        abort.abort(error)
        reject(error)
      },
      Math.max(0, timeoutMs)
    )
  })
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => doFetch(url, { ...rest, headers, signal: abort.signal }))
        .then(consume),
      timeout
    ])
  } finally {
    clearTimeout(timer)
  }
}

class RegistrationResponseError extends Error {}

const failureName = (error: unknown): string =>
  error instanceof Error ? error.name : 'UnknownError'

/**
 * Start or attach, register, write the discovery file. Resolves with the
 * handle; REJECTS with a `ServerBootError` when the server asked for cannot
 * be used (the discovery file then says `ok: false`, and nothing was started
 * in its place).
 */
export async function startServer(options: StartServerOptions): Promise<ServerHandle> {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 5000
  const launch = options.launch ?? resolveServerLaunch(options.env ?? {})
  const pid = options.identity.pid

  // Preserve the shell's light static import graph. Schemas load only for this boot.
  const [{ Schema }, { Client: ClientSchema, ClientRegistrationReservation }] = await Promise.all([
    import('effect'),
    import('@clave/contract/clients')
  ])

  let server: OwnServer | null = null
  let url: string
  let token: string | null
  if (launch.mode === 'attached') {
    url = launch.url
    token = launch.token
  } else {
    const what = launch.mode === 'separate' ? 'the separate server' : 'the in-process server'
    const start = launch.mode === 'separate' ? options.startSeparate : options.startInProcess
    try {
      if (!start) throw new Error('the shell has no starter for it')
      server = await start()
    } catch (err) {
      // A start that throws (a listener that could not bind, the package
      // failing to load, a child that never announced itself) must not leave
      // a previous boot's `ok: true` file behind: a reader would find a
      // live-looking server that is not there.
      const message = `${what} did not start: ${(err as Error).message}`
      writeDiscovery(options.userData, {
        url: '',
        token: null,
        mode: launch.mode,
        ok: false,
        error: message,
        pid,
        clientId: null
      })
      throw new ServerBootError(message, launch.mode, '')
    }
    url = server.url
    token = server.token
  }

  let reservationId: string | null = null
  let cleanup: Promise<void> | undefined
  const releaseAndStop = (): Promise<void> => {
    if (cleanup) return cleanup
    cleanup = (async () => {
      const started = performance.now()
      let releaseStatus: number | undefined
      let releaseError: unknown
      let stopError: unknown
      if (reservationId) {
        const release = (): Promise<number> =>
          call(
            doFetch,
            Math.min(timeoutMs, 1500),
            `${url}/clients/registrations/v1/release`,
            {
              method: 'POST',
              token,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: reservationId })
            },
            async (response) => {
              await response.body?.cancel()
              return response.status
            }
          )
        try {
          const status = await release().catch((error: unknown) => {
            if (error instanceof TypeError) return release()
            throw error
          })
          releaseStatus = status
          if (status < 200 || status >= 300)
            throw new Error(`Client release answered HTTP ${status}`)
          console.info(
            '[server] client cleanup ' +
              JSON.stringify({
                id: reservationId,
                outcome: 'released-or-absent',
                ms: Math.round(performance.now() - started)
              })
          )
        } catch (cause) {
          releaseError = new Error(`Client release was not acknowledged (${failureName(cause)})`, {
            cause
          })
          console.error(
            '[server] client cleanup ' +
              JSON.stringify({
                id: reservationId,
                outcome: 'unacknowledged',
                ms: Math.round(performance.now() - started),
                error: failureName(cause),
                ...(releaseStatus !== undefined && { status: releaseStatus })
              })
          )
        }
      }
      // Stopping our server is required even if release failed. Attached servers stay up.
      if (server) {
        try {
          await server.stop()
        } catch (cause) {
          stopError = new Error('Stopping the owned server failed', { cause })
        }
      }
      if (releaseError && stopError)
        throw new AggregateError(
          [releaseError, stopError],
          'Client release and owned-server stop failed'
        )
      if (releaseError) throw releaseError
      if (stopError) throw stopError
    })()
    return cleanup
  }
  const fail = async (message: string, cause?: unknown): Promise<never> => {
    let cleanupFailure: unknown
    try {
      await releaseAndStop()
    } catch (error) {
      cleanupFailure = error
    }
    const detail = message + (cleanupFailure ? '; client cleanup was not acknowledged' : '')
    const error = new ServerBootError(detail, launch.mode, url)
    error.cause = cleanupFailure
      ? new AggregateError([cause, cleanupFailure], 'Boot and cleanup failed')
      : cause
    try {
      writeDiscovery(options.userData, {
        url,
        token: null,
        mode: launch.mode,
        ok: false,
        error: detail,
        pid,
        clientId: null
      })
    } catch (discoveryFailure) {
      error.cause = new AggregateError(
        [error.cause, discoveryFailure],
        'Boot failure could not be published'
      )
    }
    throw error
  }

  // One remote budget, not a fresh full timeout for each new protocol step.
  const deadline = performance.now() + timeoutMs
  const remaining = (): number => Math.max(0, deadline - performance.now())
  let live: number
  try {
    live = await call(doFetch, remaining(), `${url}/health/live`, {}, async (response) => {
      await response.body?.cancel()
      return response.status
    })
  } catch (cause) {
    return fail(`nothing answers at ${url}: ${failureName(cause)}`, cause)
  }
  if (live < 200 || live >= 300) return fail(`${url} answered ${live} on /health/live`)

  const command = <A>(
    stage: 'reserve' | 'confirm',
    payload: unknown,
    decode: (body: unknown) => A
  ): Promise<A> =>
    call(
      doFetch,
      remaining(),
      `${url}/clients/registrations/v1/${stage}`,
      {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      },
      async (response) => {
        if (response.status === 401 || response.status === 403)
          throw new RegistrationResponseError('The server refused the token')
        if (response.status === 404 || response.status === 405)
          throw new RegistrationResponseError(
            'This server does not support desktop registration v1; upgrade the attached server before this desktop'
          )
        if (!response.ok)
          throw new RegistrationResponseError(
            `The server answered HTTP ${response.status} on registration ${stage}`
          )
        return decode(await response.json())
      }
    )
  let client: Client
  try {
    const reserved = await command(
      'reserve',
      options.identity,
      Schema.decodeUnknownSync(ClientRegistrationReservation)
    )
    reservationId = reserved.reservationId
    client = await command('confirm', { id: reservationId }, Schema.decodeUnknownSync(ClientSchema))
    if (
      client.id !== reservationId ||
      client.kind !== options.identity.kind ||
      client.name !== options.identity.name ||
      client.pid !== pid
    )
      throw new RegistrationResponseError(
        'The server returned a different desktop registration identity'
      )
  } catch (cause) {
    // Only our bounded, local status messages are public. Schema/network causes stay internal.
    const detail = cause instanceof RegistrationResponseError ? cause.message : failureName(cause)
    return fail(`registering with ${url} failed: ${detail}`, cause)
  }

  try {
    writeDiscovery(options.userData, {
      url,
      token,
      mode: launch.mode,
      ok: true,
      pid,
      clientId: client.id,
      ...(server?.pid !== undefined && { serverPid: server.pid })
    })
  } catch (cause) {
    return fail(`publishing the desktop registration failed: ${failureName(cause)}`, cause)
  }
  return {
    url,
    token: token ?? '',
    mode: launch.mode,
    clientId: client.id,
    ...(server?.pid !== undefined && { serverPid: server.pid }),
    stop: releaseAndStop
  }
}
