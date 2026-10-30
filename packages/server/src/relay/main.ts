/**
 * `clave-relay`: the relay as a process (decision 4 of the mobile spec).
 *
 *   bun packages/server/src/relay/main.ts --port 8787 --data-dir <dir> --issuer <hub> [--host <ip>]
 *
 * In development the repository's own Bun runs the TypeScript as it is; in
 * production the container image (`packages/server/relay.Dockerfile`) runs
 * the same file, configured by `RELAY_PORT`, `RELAY_HOST`, `RELAY_DATA_DIR`
 * and `RELAY_ISSUER` (a flag wins over its variable). TLS is the host's
 * proxy: the relay speaks plain HTTP on its port. Once it listens it prints
 * ONE line of JSON on stdout, `{"url":"http://<host>:<port>"}`, the way the
 * server entry announces itself; diagnostics go to stderr and never carry a
 * header value or a token. SIGTERM or SIGINT stops it: every machine is
 * told, every tunnel ended.
 */
import { startRelay } from './relay'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : undefined
}

const fail = (line: string): never => {
  process.stderr.write(`clave-relay: ${line}\n`)
  process.exit(2)
}

/** The issuer as an origin: https, or plain http to the loopback test provider. */
export function relayIssuer(raw: string | undefined): string {
  if (!raw) return fail('--issuer <hub origin> (or RELAY_ISSUER) is required')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return fail(`the issuer is not a URL: ${raw}`)
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    return fail('the issuer must be a bare origin')
  if (url.protocol === 'https:') return url.origin
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))
    return url.origin
  return fail('plain http is only accepted for a loopback issuer')
}

async function main(): Promise<void> {
  const env = process.env
  const port = Number(arg('port') ?? env.RELAY_PORT ?? '8787')
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be 0..65535`)
  const host = arg('host') ?? env.RELAY_HOST ?? '127.0.0.1'
  const dataDir = arg('data-dir') ?? env.RELAY_DATA_DIR
  if (!dataDir) fail('--data-dir <dir> (or RELAY_DATA_DIR) is required')
  const issuer = relayIssuer(arg('issuer') ?? env.RELAY_ISSUER)
  const relay = await startRelay({
    dataDir: dataDir!,
    issuer,
    host,
    port,
    log: (line) => process.stderr.write(`clave-relay: ${line}\n`)
  })
  process.stdout.write(JSON.stringify({ url: relay.url }) + '\n')
  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    process.stderr.write(`clave-relay: ${signal}, stopping\n`)
    relay.close().then(
      () => process.exit(0),
      () => process.exit(1)
    )
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

main().catch((error: unknown) => {
  process.stderr.write(`clave-relay: ${(error as Error).stack ?? String(error)}\n`)
  process.exit(1)
})
