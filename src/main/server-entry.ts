/**
 * `clave-server`: the server as its own process (ADR 0003).
 *
 *   bun src/main/server-entry.ts --data-dir <dir> [--port <n>] [--token <t>]
 *       [--terminal-process <bundle> [--node <exec>]] | [--terminals <host:port>]
 *       [--parent <pid>]
 *
 * `--daemon [--host <Tailscale-IP-or-hostname>] [--token-file <private-file>]`
 * selects independent server ownership, stable identity/credentials and a
 * shared sidebar. It forbids --parent and never prints its token. See
 * docs/server-daemon.md. Without it the app-child protocol below is retained.
 *
 * Bun runs the TypeScript as it is, so there is no build step between a
 * checkout and a running server; `npm run dev:server` and the e2e harness
 * both start it this way. Inside the packaged app (wave 5, PRDCT-3434) the
 * shell starts the same entry from the bundle electron-vite writes,
 * `out/main/server-entry.js`, under the app's own binary run as Node
 * (`src/main/server-child.ts`). Either way it binds 127.0.0.1 on the port
 * given (0, the default, asks the OS), writes `clave-server.json` into
 * `--data-dir` the way the app writes its own, and prints ONE line of JSON
 * on stdout once it listens: `{"url":"http://127.0.0.1:<port>","token":"<token>"}`.
 * Whoever started it reads that line and hands the pair to the app as
 * `CLAVE_SERVER_URL` and `CLAVE_SERVER_TOKEN`. SIGTERM or SIGINT stops it;
 * so does the end of the parent named by `--parent`, polled, so an app that
 * died without a word leaves no server behind.
 *
 * The process runs `@clave/server`, the same package the app runs in-process,
 * over the app's own session host built in this process
 * (`sessions/standalone-host.ts`, wave 3): a chat session runs its CLI as a
 * child of this process, a terminal session gets its process from the
 * terminals port. The terminals come from the terminal process (lane B of
 * wave 3, ADR 0003), and since wave 5 this entry OWNS it: with
 * `--terminal-process <bundle>` it starts the process itself, from that
 * bundle, under `--node <exec>` when given (the dev script and the harness
 * name their Node, since the Bun this entry runs under cannot run node-pty)
 * and under its own executable otherwise (the app's binary as Node), and
 * starts it again when it dies (`terminal-process/supervisor.ts`): the
 * terminals it held end with their exit, new sessions start on the new
 * process, and the readiness check `terminals` answers false in between and
 * true again after. `--terminals <host:port>` with the process's token in
 * `CLAVE_TERMINALS_TOKEN` (read once and taken out of this environment)
 * still attaches to a process somebody else started, with no restart.
 * Without either the server runs on `Terminals.none`, said on stderr, and a
 * terminal's first resize answers the declared `CapabilityUnavailable`. A
 * client sees the same API, the same token check and the same push channel
 * as in-process. Nothing here imports Electron.
 */
import * as fs from 'fs'
import * as path from 'path'
import { acquireDaemonLease, daemonConfig, daemonIdentity } from './server/daemon-config'
import { standaloneSidebar } from './server/standalone-sidebar'
import { serverOwnedSessionHost } from './sessions/server-owned-host'
import { requestAwareSessionHost } from './sessions/request-aware-host'
import { startStandaloneMcp } from './mcp/standalone-mcp'
import { executeSecretAction } from './secret-actions'
import {
  startEmbedded,
  Terminals,
  grpcTerminals,
  type TerminalsService,
  WorkspaceFiles,
  fileWorkspaceFilesStorage,
  FileTreeWatcher,
  createServerFiles,
  PendingRequests
} from '@clave/server'
import { standaloneSettingsSource } from './settings/standalone-source'
import { standaloneSessionHost } from './sessions/standalone-host'
import { installE2eHooks } from './sessions/e2e-hooks'
import { publishSessionStates, setServerEventPublisher } from './server/session-events'
import { sessionManager } from './sessions/session-manager'
import { eventsProfile, launchProfileManager } from './launch-profile-manager'
import { ptyManager, loginShellEnvAsync, getUserShell, getLoginShellEnv } from './pty-manager'
import { TEST_NO_ACTIVATE } from './test-mode'
// ── Wave 5, lane C: the plugins, this server's own service (plugins/standalone-plugins.ts) ──
import { standalonePlugins } from './plugins/standalone-plugins'
// ── Wave wcs1023, lane C: the git panel on this server's checkouts (server/git-port.ts) ──
import { serverGitPort } from './server/git-port'
import { RUN_AS_NODE_ENV, TOKEN_ENV } from './terminal-process/token-env'
import {
  spawnTerminalProcess,
  supervisedTerminals,
  type SupervisorState
} from './terminal-process/supervisor'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : undefined
}

// ── Wave 5, lane C: the host's version a plugin's `engines.clave` is judged against ──
/** The checkout's own version (`package.json` two levels up, from the sources
 *  and from `out/main` alike); a packaged server passes `--app-version`. */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8')
    ) as { version?: string }
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version
  } catch {
    /* no package.json beside a packaged server: the flag names the version */
  }
  throw new Error(
    'clave-server: --app-version <version> is required when no package.json is beside the entry'
  )
}
/** How often the parent named by `--parent` is checked for. */
const PARENT_POLL_MS = 2_000

async function main(): Promise<void> {
  // Started as Node by the app's own binary: the variable that made it so is
  // nobody else's (`terminal-process/token-env.ts`), taken out before
  // anything spawns, as the server's own two variables are by the shell.
  // The terminal process this entry starts is told it again, explicitly.
  delete process.env[RUN_AS_NODE_ENV]

  const config = daemonConfig(process.argv.slice(2))
  const dataDir = arg('data-dir')
  if (!dataDir) {
    process.stderr.write('clave-server: --data-dir <dir> is required\n')
    process.exit(2)
  }
  const port = Number(arg('port') ?? '0')
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`clave-server: --port must be 0..65535, got ${arg('port')}\n`)
    process.exit(2)
  }
  const parentRaw = arg('parent')
  const parent = parentRaw === undefined ? null : Number(parentRaw)
  if (parent !== null && (!Number.isInteger(parent) || parent <= 0)) {
    process.stderr.write(`clave-server: --parent must be a pid, got ${parentRaw}\n`)
    process.exit(2)
  }

  const releaseLease = config.daemon ? acquireDaemonLease(dataDir) : undefined
  if (releaseLease) process.once('exit', releaseLease)
  const identity = config.daemon ? daemonIdentity(dataDir, arg('token-file')) : undefined

  const log = (line: string): void => {
    process.stderr.write(`clave-server: ${line}\n`)
  }

  // ── Wave 6, lane B: the login shell's environment, read while the rest starts (PRDCT-3527) ──
  // tmux, Claude and Codex are found on its PATH, and a read made when first
  // needed is synchronous: it froze this server for two seconds at the first
  // chat a launch restored. Started here, in parallel with the terminal
  // process and the listener; a spawn waits for it (`sessions/lifecycle.ts`)
  // and the records listing uses the tmux the last launch found until it is
  // there (`detectTmux`), so the announcement never waits on it.
  void loginShellEnvAsync()

  // ── Lane B (wave 3): the terminals, over the wire to the terminal process ──
  // ── Wave 5: the process started and kept alive by this entry ──
  const terminalsAddress = arg('terminals')
  const terminalProcessBundle = arg('terminal-process')
  const terminalsToken = process.env[TOKEN_ENV]
  delete process.env[TOKEN_ENV]
  let terminals: TerminalsService = Terminals.none
  let closeTerminals: () => Promise<void> = async () => {}
  let terminalState: SupervisorState | null = null
  // The discovery file follows the terminal process (its pid and address
  // change at every restart); written once the server listens, below.
  let writeDiscovery: () => void = () => {}
  if (terminalProcessBundle !== undefined && terminalsAddress !== undefined) {
    process.stderr.write('clave-server: give --terminal-process or --terminals, not both\n')
    process.exit(2)
  }
  if (terminalProcessBundle !== undefined) {
    if (!fs.existsSync(terminalProcessBundle)) {
      process.stderr.write(
        `clave-server: the terminal process bundle is missing (${terminalProcessBundle}): run \`npx electron-vite build\` first\n`
      )
      process.exit(2)
    }
    const exec = arg('node') ?? process.execPath
    // The first start is this entry's to fail on: a server told to run a
    // terminal process that cannot start exits 2, the code of a command
    // line it cannot honour, rather than coming up on no terminals.
    const supervisor = await supervisedTerminals({
      start: () =>
        spawnTerminalProcess({
          exec,
          bundle: terminalProcessBundle,
          parent: process.pid,
          log: (line) => process.stderr.write(`${line}\n`)
        }),
      log: (line) => log(`terminals: ${line}`),
      onChange: (state) => {
        terminalState = state
        writeDiscovery()
      }
    }).catch((err: Error) => {
      process.stderr.write(
        `clave-server: the terminal process did not start: ${err.message.split('\n')[0]}\n`
      )
      return process.exit(2)
    })
    terminalState = supervisor.state()
    terminals = supervisor
    closeTerminals = supervisor.close
  } else if (terminalsAddress !== undefined) {
    if (!terminalsToken) {
      process.stderr.write(
        `clave-server: --terminals needs the terminal process token in ${TOKEN_ENV}\n`
      )
      process.exit(2)
    }
    const port = grpcTerminals({
      address: terminalsAddress,
      token: terminalsToken,
      log: (line) => log(`terminals: ${line}`)
    })
    terminals = port
    closeTerminals = port.close
  } else {
    process.stderr.write(
      'clave-server: no --terminal-process and no --terminals given, this server runs no terminals (a spawn answers CapabilityUnavailable)\n'
    )
  }

  const token = arg('token')
  // The settings (lane D): the same managers as the app's, on JSON documents
  // under `--data-dir` and the macOS Keychain (`CLAVE_KEYCHAIN_FILE` names
  // a keychain file instead of the login keychain, the harness's way of
  // never touching a personal one); a login job or the app icon asked of
  // this server answers CapabilityUnavailable. The Antasphere account
  // (PRDCT-3259) is this server's own, restored from the data directory.
  const standalone = standaloneSettingsSource(dataDir)
  // Installed FIRST: the session host's spawn reads the profiles and the
  // accounts through the same ports. The source is on the test hooks
  // namespace for the quota specs, as the shell's is.
  installE2eHooks({ settings: standalone.settings })
  // ── Lane C: the sessions, the app's own host in this process (wave 3) ──
  // and, wave 4, the agent tokens the server resolves for the attached shell.
  const { host: originalSessions, agentTools } = standaloneSessionHost({ dataDir, terminals })
  const sidebar = config.daemon ? standaloneSidebar(dataDir) : undefined
  const owned = sidebar
    ? serverOwnedSessionHost({
        host: originalSessions,
        sidebar,
        dataDir,
        subscribeAll: (listener) => sessionManager.subscribeAll(listener),
        ready: (id) => sessionManager.ready(id)
      })
    : undefined
  const requests = new PendingRequests()
  const requestHost = requestAwareSessionHost({
    host: owned?.host ?? originalSessions,
    requests,
    subscribeAll: (listener) => sessionManager.subscribeAll(listener),
    subscribeRemoved: (listener) => sessionManager.subscribeRemoved(listener)
  })
  const sessions = requestHost.host
  installE2eHooks({ sessionHost: sessions })
  // ── Wave 5, lane C: the plugins (PRDCT-3433) ──
  // The installed plugins, their host and the view leases are this server's:
  // the store under `--data-dir/clave-plugins` in test mode (`~/.clave`
  // otherwise, where the app keeps it), the bundled plugins from
  // `--plugins-bundled <dir>` (the checkout's `plugins/` by default), the
  // host's version from `--app-version` (the checkout's package.json by
  // default), each plugin's `main` in a process forked under Node IPC. Built
  // AFTER the session host: a plugin's adapters register with this process's
  // session manager, so a session this server starts can run them.
  const plugins = standalonePlugins({
    dataDir,
    bundled: arg('plugins-bundled') ?? path.resolve(__dirname, '..', '..', 'plugins'),
    version: arg('app-version') ?? readAppVersion()
  })
  installE2eHooks({ plugins })
  const server = await startEmbedded({
    ports: {
      sessions,
      requests,
      files: createServerFiles({
        attachmentsRoot: path.join(dataDir, 'session-attachments'),
        watcher: new FileTreeWatcher()
      }),
      terminals,
      ...(sidebar && { sidebar }),
      settings: standalone.settings,
      // The workspace files (wave 3, lane A): the `.clave` files of this
      // machine, their trust store under `--data-dir`; a review a read needs
      // is published to the clients and the read waits for the answer.
      workspaceFiles: new WorkspaceFiles(fileWorkspaceFilesStorage(dataDir)),
      // ── Wave 4, lane C: the agent tokens, resolved for the attached shell ──
      // A desktop may still announce its own endpoint for old servers. This
      // server owns its endpoint and never points local providers at a Mac.
      agentTools: config.daemon
        ? { announce: () => {}, resolve: (token) => agentTools.resolve(token) }
        : agentTools,
      // ── Wave 5, lane C: the plugins ──
      plugins,
      // ── Wave wcs1023, lane C: the git panel on this server's checkouts: the
      // app's own git implementation, its repo watcher's bursts and a batch's
      // progress published to every attached client (server/git-port.ts).
      git: serverGitPort()
    },
    port,
    host: config.host,
    ...(identity ?? (token !== undefined ? { token } : {})),
    // ── Lane C of wave 3: the end-to-end fixture route, under the app's own
    // test flag (`--test-no-activate`, passed by the harness and never by
    // the packaged app), so the suite reaches this process as it reaches
    // the app's; off, the route does not exist.
    testFixtures: TEST_NO_ACTIVATE
  })

  const mcp = config.daemon
    ? await startStandaloneMcp({
        sessions,
        agentTools,
        requests,
        ...(sidebar && { sidebar }),
        // An agent's profile must belong to the mode it opens (a chat or
        // plugin profile, or one of this server's custom profiles).
        profileFamily: (id) =>
          eventsProfile(id)?.family ??
          launchProfileManager.getPreferences().customProfiles.find((p) => p.id === id)?.family,
        executeSecret: async (action, value) => {
          const outcome = await executeSecretAction(
            action,
            value,
            action.type === 'run' ? { shell: getUserShell(), env: getLoginShellEnv() } : undefined
          )
          if (!outcome.ok) throw new Error('Secret action failed.')
        }
      })
    : undefined
  if (mcp) agentTools.announce(mcp.url)

  // A session's title, plan, clear and state go out as server events to
  // every attached client (`server/session-events.ts`), as the in-process
  // entry publishes them.
  setServerEventPublisher((event) => server.publish(event))
  const stopStates = publishSessionStates(sessionManager, (event) => server.publish(event))

  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'clave-server.json')
  // What the file says of the terminal process is read by the harness and
  // the process starter's tests; it carries no token of the process's.
  writeDiscovery = (): void => {
    const tmp = `${file}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        {
          url: server.url,
          token: server.token,
          serverId: server.serverId,
          ...(mcp && { agentToolsUrl: mcp.url }),
          daemon: config.daemon,
          mode: 'standalone',
          ok: true,
          pid: process.pid,
          terminals: terminalState?.address ?? terminalsAddress ?? null,
          terminalProcessPid: terminalState?.pid ?? null,
          terminalProcessGeneration: terminalState?.generation ?? null,
          terminalProcessGivenUp: terminalState?.givenUp ?? null
        },
        null,
        2
      ),
      { encoding: 'utf-8', mode: 0o600 }
    )
    fs.renameSync(tmp, file)
    fs.chmodSync(file, 0o600)
  }
  writeDiscovery()

  process.stdout.write(
    JSON.stringify(
      config.daemon
        ? { url: server.url, serverId: server.serverId }
        : { url: server.url, token: server.token }
    ) + '\n'
  )
  process.stderr.write(
    `clave-server: listening on ${server.url} (data in ${dataDir}` +
      (terminalState
        ? `, terminal process ${terminalState.pid} at ${terminalState.address}`
        : terminalsAddress === undefined
          ? ''
          : `, terminals at ${terminalsAddress}`) +
      (parent === null ? '' : `, parent ${parent}`) +
      ')\n'
  )

  let stopping = false
  const sessions_shutdown = (): void => {
    // `quit: true`: the standalone server's stop is a quit for its sessions,
    // so the title generator's one-shot CLI dies with them, as on the app's
    // quit (lane A, wave 4; the round-3 verifier of wave 3 found one alive).
    stopping_sessions = ptyManager.killAll({ quit: true }).catch((error) => {
      process.stderr.write(`clave-server: session shutdown failed: ${(error as Error).message}\n`)
    })
  }
  let stopping_sessions: Promise<void> = Promise.resolve()
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    writeDiscovery = (): void => {}
    process.stderr.write(`clave-server: ${signal}, stopping\n`)
    // The login's listener and timers go with the server; the session on
    // disk is kept as it is for the next start.
    standalone.shutdown()
    requestHost.close()
    requests.close()
    owned?.close()
    stopStates()
    setServerEventPublisher(null)
    // ── Wave 5, lane C: the plugin processes go with the server ──
    plugins.close()
    // The sessions go with the server, as they go with the app at its quit
    // (`index.ts`): a chat's CLI is a detached child of this process and
    // would outlive it; a terminal's tmux session is left for the next
    // start, the way the app's quit leaves it (kill with killTmuxSession
    // false, which killAll does).
    sessions_shutdown()
    // The discovery file goes with the process: a reader must never find
    // the url and the token of a server that is gone.
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* nothing to remove */
    }
    stopping_sessions
      .then(() => mcp?.close())
      .then(() => server.stop())
      .then(() => closeTerminals())
      .then(
        () => process.exit(0),
        () => process.exit(1)
      )
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  // The parent's end stops this server, the way it stops the terminal
  // process (`terminal-process/main.ts`): an app that died without a word
  // leaves no server behind, and no terminal process either, since that one
  // polls this server.
  if (parent !== null) {
    const watch = setInterval(() => {
      try {
        process.kill(parent, 0)
      } catch {
        clearInterval(watch)
        stop(`parent ${parent} is gone`)
      }
    }, PARENT_POLL_MS)
    watch.unref()
  }
}

main().catch((err) => {
  process.stderr.write(`clave-server: ${(err as Error).stack ?? err}\n`)
  process.exit(1)
})
