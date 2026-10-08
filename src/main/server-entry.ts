/**
 * `clave-server`: the server as its own process (ADR 0003).
 *
 *   bun src/main/server-entry.ts --data-dir <dir> [--port <n>] [--token <t>]
 *                                [--terminals <host:port>]
 *
 * Bun runs the TypeScript as it is, so there is no build step between a
 * checkout and a running server; `npm run dev:server` and the e2e harness
 * both start it this way. It binds 127.0.0.1 on the port given (0, the
 * default, asks the OS), writes `clave-server.json` into `--data-dir` the way
 * the app writes its own, and prints ONE line of JSON on stdout once it
 * listens: `{"url":"http://127.0.0.1:<port>","token":"<token>"}`. Whoever
 * started it reads that line and hands the pair to the app as
 * `CLAVE_SERVER_URL` and `CLAVE_SERVER_TOKEN`. SIGTERM or SIGINT stops it.
 *
 * The process runs `@clave/server`, the same package the app runs in-process,
 * over the app's own session host built in this process
 * (`sessions/standalone-host.ts`, wave 3): a chat session runs its CLI as a
 * child of this process, a terminal session gets its process from the
 * terminals port. The terminals come from the terminal process (lane B of
 * wave 3, ADR 0003): with `--terminals <host:port>` and the process's token
 * in `CLAVE_TERMINALS_TOKEN` (read once and taken out of this environment),
 * `ports.terminals` is the gRPC port to it, and the server's readiness
 * carries a `terminals` check that turns false when the process stops
 * answering. Without `--terminals` the server runs on `Terminals.none`, said
 * on stderr, and a terminal's first resize answers the declared
 * `CapabilityUnavailable`. A client sees the same API, the same token check
 * and the same push channel as in-process. Nothing here imports
 * Electron.
 */
import * as fs from 'fs'
import * as path from 'path'
import { startEmbedded, Terminals, grpcTerminals, type TerminalsService } from '@clave/server'
import { standaloneSettingsSource } from './settings/standalone-source'
import { standaloneSessionHost } from './sessions/standalone-host'
import { installE2eHooks } from './sessions/e2e-hooks'
import { publishSessionStates, setServerEventPublisher } from './server/session-events'
import { sessionManager } from './sessions/session-manager'
import { TEST_NO_ACTIVATE } from './test-mode'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : undefined
}

async function main(): Promise<void> {
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

  // ── Lane B: the terminals, over the wire to the terminal process ──
  const terminalsAddress = arg('terminals')
  const terminalsToken = process.env.CLAVE_TERMINALS_TOKEN
  delete process.env.CLAVE_TERMINALS_TOKEN
  let terminals: TerminalsService = Terminals.none
  let closeTerminals: () => Promise<void> = async () => {}
  if (terminalsAddress !== undefined) {
    if (!terminalsToken) {
      process.stderr.write(
        'clave-server: --terminals needs the terminal process token in CLAVE_TERMINALS_TOKEN\n'
      )
      process.exit(2)
    }
    const port = grpcTerminals({
      address: terminalsAddress,
      token: terminalsToken,
      log: (line) => process.stderr.write(`clave-server: terminals: ${line}\n`)
    })
    terminals = port
    closeTerminals = port.close
  } else {
    process.stderr.write(
      'clave-server: no --terminals given, this server runs no terminals (a spawn answers CapabilityUnavailable)\n'
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
  const sessions = standaloneSessionHost({ dataDir, terminals })
  const server = await startEmbedded({
    ports: {
      sessions,
      terminals,
      settings: standalone.settings
    },
    port,
    ...(token !== undefined && { token }),
    // ── Lane C of wave 3: the end-to-end fixture route, under the app's own
    // test flag (`--test-no-activate`, passed by the harness and never by
    // the packaged app), so the suite reaches this process as it reaches
    // the app's; off, the route does not exist.
    testFixtures: TEST_NO_ACTIVATE
  })

  // A session's title, plan, clear and state go out as server events to
  // every attached client (`server/session-events.ts`), as the in-process
  // entry publishes them.
  setServerEventPublisher((event) => server.publish(event))
  const stopStates = publishSessionStates(sessionManager, (event) => server.publish(event))

  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'clave-server.json')
  const tmp = `${file}.tmp`
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      { url: server.url, token: server.token, mode: 'standalone', ok: true, pid: process.pid },
      null,
      2
    ),
    { encoding: 'utf-8', mode: 0o600 }
  )
  fs.renameSync(tmp, file)
  fs.chmodSync(file, 0o600)

  process.stdout.write(JSON.stringify({ url: server.url, token: server.token }) + '\n')
  process.stderr.write(
    `clave-server: listening on ${server.url} (data in ${dataDir}` +
      (terminalsAddress === undefined ? '' : `, terminals at ${terminalsAddress}`) +
      ')\n'
  )

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    process.stderr.write(`clave-server: ${signal}, stopping\n`)
    // The login's listener and timers go with the server; the session on
    // disk is kept as it is for the next start.
    standalone.shutdown()
    stopStates()
    setServerEventPublisher(null)
    // The discovery file goes with the process: a reader must never find
    // the url and the token of a server that is gone.
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* nothing to remove */
    }
    server
      .stop()
      .then(() => closeTerminals())
      .then(
        () => process.exit(0),
        () => process.exit(1)
      )
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

main().catch((err) => {
  process.stderr.write(`clave-server: ${(err as Error).stack ?? err}\n`)
  process.exit(1)
})
