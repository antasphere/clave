/**
 * The separate server as a child of the shell (ADR 0003, wave 5, PRDCT-3434).
 *
 * The packaged app carries the standalone entry and the terminal process as
 * two bundles beside its main one (`out/main/server-entry.js` and
 * `out/main/terminal-process.js`, inside `app.asar`), and runs them under
 * its OWN binary as Node (`ELECTRON_RUN_AS_NODE`), so nothing is added to
 * the download and no second binary is signed: the same Node 22 Electron
 * embeds, which reads the asar and loads the native modules the app
 * unpacked. The command is one function (`serverChildCommand`), tested on
 * its own; `startSeparateServer` spawns it, reads the entry's one
 * announcement line off stdout (`terminal-process/announcing.ts`), relays
 * its stderr into the app's log, and answers the `OwnServer` the boot
 * attaches to (`server-boot.ts`).
 *
 * What the child is told: the data directory of its own (never the app's,
 * ADR 0003: two processes on one folder would write the same files), the
 * terminal process bundle it starts and keeps alive (`--terminal-process`),
 * the shell's pid as its parent (`--parent`, so a shell that died without a
 * word leaves no server behind), and the shell's own test flags
 * (`--test-no-activate`, the echo adapter's), which are what turn the
 * fixture route and the terminal journal on under the harness and nothing
 * else. Its environment is the shell's with `ELECTRON_RUN_AS_NODE` added and
 * the server's own two variables taken out again, defensively: the shell
 * removed them at its boot, and a child must never find an outer server's
 * address in its environment.
 *
 * The stop is bounded: SIGTERM, then SIGKILL after `SEPARATE_SERVER_KILL_AFTER_MS`,
 * inside the quit's ceiling (`quit-cleanup.ts`); the entry's own stop ends
 * its sessions and its terminal process on the way. A child that ends while
 * the app runs is reported through `onExit`: nothing restarts it in this
 * lane (listed in ADR 0003), the windows keep the address and their calls
 * say the server is gone, never a silent fallback to another server.
 *
 * Nothing here imports Electron: the paths come in as arguments.
 */
import * as path from 'node:path'
import { ENV_SERVER_TOKEN, ENV_SERVER_URL } from '@clave/contract/env'
import { exitOf, startAnnouncing, stopChild } from './terminal-process/announcing'
import { RUN_AS_NODE_ENV } from './terminal-process/token-env'
import type { OwnServer } from './server-boot'

/** How long the entry has to announce itself: a cold start inside the
 *  package measured at 1.1 s on 12 October 2026 (the first terminal process
 *  starts inside it). */
export const SEPARATE_SERVER_ANNOUNCE_TIMEOUT_MS = 20_000
/** SIGKILL this long after the SIGTERM; with the quit's other waits it must
 *  stay inside `QUIT_CEILING_MS`. */
export const SEPARATE_SERVER_KILL_AFTER_MS = 3_000

/** The two bundles the child runs from, beside the main one. */
export const SERVER_ENTRY_BUNDLE = 'server-entry.js'
export const TERMINAL_PROCESS_BUNDLE = 'terminal-process.js'

export interface ServerChildOptions {
  /** The app's own binary (`process.execPath`). */
  readonly execPath: string
  /** Where the bundles are: main's own `__dirname` (`out/main`, or the same
   *  folder inside the asar). */
  readonly bundleDir: string
  /** The server's data directory, its own. */
  readonly dataDir: string
  /** The shell's pid, the child's parent. */
  readonly parent: number
  /** The shell's test flags, passed on as they are. */
  readonly flags?: readonly string[]
  /** The folder of the plugins the app ships (`Resources/plugins` packaged,
   *  outside the asar, so the entry's default beside its bundle finds
   *  nothing there), told to the entry as `--plugins-bundled` (wave 5,
   *  lane C's plugin host on the server). */
  readonly pluginsBundled?: string
  /** The app's version, told as `--app-version`: a plugin's `engines.clave`
   *  is judged against it. */
  readonly appVersion?: string
  /** The environment to start from; the process's by default. */
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly killAfterMs?: number
  /** The child's stderr lines and this starter's own, for the app's log. */
  readonly log?: (line: string) => void
  /** The child ended while the app was not stopping it. */
  readonly onExit?: (code: number | string | null) => void
}

export interface ServerChildCommand {
  readonly cmd: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

/** The command line and the environment of the child. Pure. */
export function serverChildCommand(
  options: Pick<
    ServerChildOptions,
    | 'execPath'
    | 'bundleDir'
    | 'dataDir'
    | 'parent'
    | 'flags'
    | 'env'
    | 'pluginsBundled'
    | 'appVersion'
  >
): ServerChildCommand {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), [RUN_AS_NODE_ENV]: '1' }
  delete env[ENV_SERVER_URL]
  delete env[ENV_SERVER_TOKEN]
  return {
    cmd: options.execPath,
    args: [
      path.join(options.bundleDir, SERVER_ENTRY_BUNDLE),
      '--data-dir',
      options.dataDir,
      '--port',
      '0',
      '--terminal-process',
      path.join(options.bundleDir, TERMINAL_PROCESS_BUNDLE),
      '--parent',
      String(options.parent),
      ...(options.pluginsBundled ? ['--plugins-bundled', options.pluginsBundled] : []),
      ...(options.appVersion ? ['--app-version', options.appVersion] : []),
      ...(options.flags ?? [])
    ],
    env
  }
}

/** The main-process flags a child entry reads too: the test mode that turns
 *  the fixture route and the journal on, and the development adapters. */
export function flagsForServerChild(argv: readonly string[]): string[] {
  return argv.filter((a) => a.startsWith('--test-') || a.startsWith('--dev-'))
}

export interface SeparateServer extends OwnServer {
  readonly pid: number
  readonly stop: () => Promise<void>
}

/** Start the child and resolve once it announced its url and token. Rejects,
 *  with the child killed and gone, when it exits first or stays silent past
 *  the timeout, its stderr in the message. */
export async function startSeparateServer(options: ServerChildOptions): Promise<SeparateServer> {
  const log = options.log ?? (() => {})
  const command = serverChildCommand(options)
  const { child, announced } = startAnnouncing({
    what: 'the separate server',
    cmd: command.cmd,
    args: command.args,
    env: command.env,
    timeoutMs: options.timeoutMs ?? SEPARATE_SERVER_ANNOUNCE_TIMEOUT_MS,
    fields: ['url', 'token'],
    onStderr: (line) => log(line)
  })
  const { url, token } = await announced
  let stopping = false
  void exitOf(child).then((code) => {
    if (stopping) return
    log(`the separate server exited (${code}) while the app was running`)
    options.onExit?.(code)
  })
  return {
    url,
    token,
    pid: child.pid ?? 0,
    stop: async () => {
      stopping = true
      await stopChild(child, options.killAfterMs ?? SEPARATE_SERVER_KILL_AFTER_MS)
    }
  }
}
