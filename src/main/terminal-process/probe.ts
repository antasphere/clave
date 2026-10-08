/**
 * The terminal port over the wire, driven from Bun: the one proof that the
 * standalone server's side of the terminals (`grpcTerminals`, on the
 * framework's gRPC client) works under the Bun the repository pins, which
 * the framework requires at 1.4.1 and which no vitest run (Node) can show.
 *
 *   bun src/main/terminal-process/probe.ts --address <host:port> --token <t>
 *
 * It spawns `/bin/sh -c 'read x; echo got:$x; exit 7'` through the port,
 * writes `ping` to it, and prints ONE JSON line, `{"pid","output","exit"}`,
 * once the terminal has exited; `scripts/server-process.test.mjs` runs it
 * against a terminal process started from the built bundle and asserts on
 * the line. Exit 1 with the reason on stderr otherwise.
 */
import { grpcTerminals } from '@clave/server'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

const address = arg('address')
const token = arg('token')
if (!address || !token) {
  process.stderr.write('probe: --address and --token are required\n')
  process.exit(2)
}

const port = grpcTerminals({
  address,
  token,
  log: (line) => process.stderr.write(`probe: ${line}\n`)
})
const timer = setTimeout(() => {
  process.stderr.write('probe: no exit within 10 s\n')
  process.exit(1)
}, 10_000)

let output = ''
const terminal = port.spawn({
  file: '/bin/sh',
  args: ['-c', 'read x; echo got:$x; exit 7'],
  cwd: '/',
  env: { PATH: '/bin:/usr/bin' },
  cols: 80,
  rows: 24
})
terminal.onData((data) => {
  output += data
})
terminal.onExit((exit) => {
  clearTimeout(timer)
  process.stdout.write(JSON.stringify({ pid: terminal.pid, output, exit }) + '\n')
  port.close().then(
    () => process.exit(0),
    () => process.exit(1)
  )
})
terminal.write('ping\n')
