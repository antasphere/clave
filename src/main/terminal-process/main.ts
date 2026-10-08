/**
 * `clave-terminals`: the terminal process as a command (ADR 0003, wave 3).
 *
 *   node out/main/terminal-process.js [--port <n>] [--parent <pid>]
 *
 * Built by electron-vite with the main process (`electron.vite.config.ts`,
 * the `terminal-process` input): it cannot run from its TypeScript sources
 * under plain Node, since the framework ships sources too and Node strips no
 * types under `node_modules`. `scripts/server-process.mjs` starts it before
 * the server and hands the server its address and its token.
 *
 * The token comes in as `CLAVE_TERMINALS_TOKEN`, read once and taken out of
 * this process's environment before any terminal spawns (a terminal gets the
 * environment of its spawn request, never this process's, but the rule of
 * the server entry holds here too); a fresh one is drawn when none is given.
 * It prints ONE line of JSON on stdout once it listens,
 * `{"address":"127.0.0.1:<port>","token":"<token>"}`, and nothing else on
 * stdout, ever. SIGTERM or SIGINT stops it; so does the end of the parent
 * named by `--parent`, polled, so a server that died without a word leaves
 * no terminal process behind.
 */
import { randomBytes } from 'node:crypto'
import { startTerminalProcess } from './server'

export const TOKEN_ENV = 'CLAVE_TERMINALS_TOKEN'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : undefined
}

const fail = (message: string): never => {
  process.stderr.write(`clave-terminals: ${message}\n`)
  process.exit(2)
}

async function main(): Promise<void> {
  const port = Number(arg('port') ?? '0')
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    fail(`--port must be 0..65535, got ${arg('port')}`)
  const parentRaw = arg('parent')
  const parent = parentRaw === undefined ? null : Number(parentRaw)
  if (parent !== null && (!Number.isInteger(parent) || parent <= 0))
    fail(`--parent must be a pid, got ${parentRaw}`)

  const token = process.env[TOKEN_ENV] || randomBytes(32).toString('hex')
  delete process.env[TOKEN_ENV]

  const log = (line: string): void => {
    process.stderr.write(`clave-terminals: ${line}\n`)
  }
  const handle = await startTerminalProcess({ token, address: `127.0.0.1:${port}`, log })

  process.stdout.write(JSON.stringify({ address: handle.address, token }) + '\n')
  log(`listening on ${handle.address}`)

  let stopping = false
  const stop = (why: string): void => {
    if (stopping) return
    stopping = true
    log(`${why}, stopping`)
    handle.close().then(
      () => process.exit(0),
      () => process.exit(1)
    )
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  if (parent !== null) {
    const watch = setInterval(() => {
      try {
        process.kill(parent, 0)
      } catch {
        clearInterval(watch)
        stop(`parent ${parent} is gone`)
      }
    }, 2_000)
    watch.unref()
  }
}

main().catch((err) => {
  process.stderr.write(`clave-terminals: ${(err as Error).stack ?? err}\n`)
  process.exit(1)
})
