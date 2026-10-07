/**
 * `clave-server`: the server as its own process (ADR 0003).
 *
 *   bun src/main/server-entry.ts --data-dir <dir> [--port <n>] [--token <t>]
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
 * with NO session host: the sessions domain is on the server (wave 2), but a
 * standalone server has no terminal process to run them until wave 3, so it
 * lists none and answers every start with a declared `CapabilityUnavailable`
 * that names what is missing. A client sees the same API, the same token
 * check and the same push channel as in-process. Nothing here imports
 * Electron.
 */
import * as fs from 'fs'
import * as path from 'path'
import { startEmbedded, SessionHost } from '@clave/server'
import { standaloneSettingsSource } from './settings/standalone-source'

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

  const token = arg('token')
  const server = await startEmbedded({
    // No terminal process beside this server yet (wave 3): a start answers
    // `CapabilityUnavailable` and says so, the reads answer empty.
    ports: {
      sessions: SessionHost.none,
      // The settings (lane D): the same managers as the app's, on JSON
      // documents under `--data-dir` and the macOS Keychain; a login or the
      // app icon asked of this server answers CapabilityUnavailable.
      settings: standaloneSettingsSource(dataDir)
    },
    port,
    ...(token !== undefined && { token })
  })

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
  process.stderr.write(`clave-server: listening on ${server.url} (data in ${dataDir})\n`)

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    process.stderr.write(`clave-server: ${signal}, stopping\n`)
    // The discovery file goes with the process: a reader must never find
    // the url and the token of a server that is gone.
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* nothing to remove */
    }
    server.stop().then(
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
