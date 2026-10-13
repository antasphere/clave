/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, shared by the dev script and the e2e harness */
// The server as its own process, started from a checkout (ADR 0003).
//
// ONE place names the commands, for the dev script (scripts/dev-attached.mjs)
// and the e2e harness (tests/e2e/harness.mjs) alike. Two processes:
//
// - The terminal process (wave 3): `node out/main/terminal-process.js`, the
//   Node process that owns node-pty, built by electron-vite with the main
//   process (it cannot run from its sources under plain Node). It is started
//   FIRST, prints one JSON line `{"address","token"}` on stdout once it
//   listens, and the server is told both.
// - The server: `src/main/server-entry.ts` under Bun, which runs the
//   TypeScript as it is: `@clave/server`, the same package the app runs
//   in-process, its terminals over the wire to the process above. The
//   contract that stays: the process binds 127.0.0.1, and prints ONE JSON line
//   `{"url","token"}` on stdout once it listens.
//
// `terminals: 'none'` starts the server alone, on no terminals, for a caller
// that has no bundle and needs none (the server's own unit tests). It is
// never a fallback: a missing bundle with `terminals: 'sidecar'` is an error
// naming the build to run.
//
// Bun is the repository's own first (`node_modules/.bin/bun`, the `bun` dev
// dependency pinned at the version the framework's gRPC package needs), so
// the machine's Bun is neither required nor changed.
//
// Nothing here listens on, or upgrades, the server's port: the push channel
// is a WebSocket upgrade on that same port (lane A), and a second handler
// there corrupts frames.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Where `bun` is: `CLAVE_BUN`, then the repository's own, then the PATH,
 *  then the default install. */
export function bunBinary(env = process.env, repo = undefined) {
  if (env.CLAVE_BUN) return env.CLAVE_BUN
  if (repo) {
    const own = path.join(repo, 'node_modules', '.bin', 'bun')
    if (existsSync(own)) return own
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, 'bun'))) return path.join(dir, 'bun')
  }
  const home = path.join(os.homedir(), '.bun', 'bin', 'bun')
  if (existsSync(home)) return home
  throw new Error(
    'bun was not found (CLAVE_BUN, node_modules/.bin/bun, the PATH, ~/.bun/bin/bun). The server entry runs under Bun: npm install, or https://bun.sh'
  )
}

/** The built terminal process, as electron-vite writes it. */
export function terminalProcessBundle(repo) {
  return path.join(repo, 'out', 'main', 'terminal-process.js')
}

/** The command line that starts the terminal process, port 0 = any free.
 *  Throws, naming the build, when the bundle is not there. */
export function terminalProcessCommand({ repo, port = 0, parent = process.pid }) {
  const bundle = terminalProcessBundle(repo)
  if (!existsSync(bundle))
    throw new Error(
      `the terminal process bundle is missing (${bundle}): run \`npx electron-vite build\` first`
    )
  return {
    cmd: process.execPath,
    args: [bundle, '--port', String(port), '--parent', String(parent)]
  }
}

/** The command line that starts the server on `dataDir`, port 0 = any free;
 *  `terminals` the address of the terminal process, or none; `args` extra
 *  flags the entry reads off its argv (the harness passes the app's own test
 *  flags, `--test-no-activate` and the echo adapter's). */
export function serverCommand({
  repo,
  dataDir,
  port = 0,
  env = process.env,
  terminals,
  args = []
}) {
  return {
    cmd: bunBinary(env, repo),
    args: [
      path.join(repo, 'src', 'main', 'server-entry.ts'),
      '--data-dir',
      dataDir,
      '--port',
      String(port),
      ...(terminals ? ['--terminals', terminals] : []),
      ...args
    ]
  }
}

/**
 * Start a child and resolve its first stdout line, parsed as JSON and
 * checked to carry the `fields` named. Rejects when it exits first, stays
 * silent past `timeoutMs`, or prints something else, with its stderr in the
 * message; a child that never announced itself is killed HERE before the
 * rejection and the rejection waits for it to be gone: nobody else holds its
 * pid, so nothing else could sweep it, and a late process would otherwise
 * live on past the run on a random port with its token on disk. The
 * rejection carries `pid` for the record.
 */
function startAnnouncing({ what, cmd, args, cwd, env, timeoutMs, fields }) {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })
  const announced = new Promise((resolve, reject) => {
    let out = ''
    let settled = false
    const done = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (fn === reject) {
        if (value instanceof Error) value.pid = child.pid
        const finish = () => fn(value)
        if (child.exitCode !== null || child.signalCode !== null) return finish()
        const grace = setTimeout(finish, 2_000)
        child.once('exit', () => {
          clearTimeout(grace)
          finish()
        })
        try {
          child.kill('SIGKILL')
        } catch {
          clearTimeout(grace)
          finish()
        }
        return
      }
      fn(value)
    }
    const timer = setTimeout(
      () => done(reject, new Error(`${what} did not announce itself in ${timeoutMs}ms\n${stderr}`)),
      timeoutMs
    )
    child.stdout.on('data', (d) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl < 0) return
      const line = out.slice(0, nl)
      try {
        const parsed = JSON.parse(line)
        for (const field of fields)
          if (typeof parsed?.[field] !== 'string')
            throw new Error(`${fields.join(' and ')} expected`)
        done(resolve, parsed)
      } catch (err) {
        done(reject, new Error(`unreadable ${what} announcement "${line}": ${err.message}`))
      }
    })
    child.once('error', (err) => done(reject, new Error(`could not start ${cmd}: ${err.message}`)))
    child.once('exit', (code, signal) =>
      done(
        reject,
        new Error(`${what} exited (${code ?? signal}) before announcing itself\n${stderr}`)
      )
    )
  })
  return { child, announced, stderr: () => stderr }
}

/** SIGTERM a child and wait for it, SIGKILL after `killAfterMs`. */
function stopChild(child, killAfterMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const hard = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, killAfterMs)
    child.once('exit', () => {
      clearTimeout(hard)
      resolve()
    })
    try {
      child.kill('SIGTERM')
    } catch {
      clearTimeout(hard)
      resolve()
    }
  })
}

/**
 * Start the terminal process alone and resolve once it announced itself.
 * `stop()` sends SIGTERM and waits, SIGKILL after `killAfterMs`; `exited`
 * resolves when the process ends, however it ends.
 */
export async function startTerminalProcess({
  repo,
  port = 0,
  timeoutMs = 15_000,
  killAfterMs = 5_000,
  env = process.env
}) {
  const { cmd, args } = terminalProcessCommand({ repo, port })
  const { child, announced, stderr } = startAnnouncing({
    what: 'the terminal process',
    cmd,
    args,
    cwd: repo,
    env,
    timeoutMs,
    fields: ['address', 'token']
  })
  const { address, token } = await announced
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve(code ?? signal))
  )
  return {
    address,
    token,
    pid: child.pid,
    stderr,
    exited,
    stop: () => stopChild(child, killAfterMs)
  }
}

/**
 * Start the server, with its terminal process first unless `terminals` is
 * `'none'`, and resolve once the server announced itself. Rejects when
 * either exits first or stays silent past `timeoutMs`, with its stderr in
 * the message, and nothing of the pair left running. `stop()` ends the
 * server (SIGTERM, SIGKILL after `killAfterMs`), then the terminal process
 * the same way. `terminalProcess` carries the latter's `pid`, `stop` and
 * `exited` so a caller can watch it, or end it on purpose.
 */
export async function startServerProcess({
  repo,
  dataDir,
  port = 0,
  timeoutMs = 15_000,
  killAfterMs = 5_000,
  env = process.env,
  terminals = 'sidecar',
  args: extraArgs = []
}) {
  if (terminals !== 'sidecar' && terminals !== 'none')
    throw new Error(`startServerProcess: terminals must be "sidecar" or "none", got ${terminals}`)
  mkdirSync(dataDir, { recursive: true })

  const sidecar =
    terminals === 'sidecar'
      ? await startTerminalProcess({ repo, timeoutMs, killAfterMs, env })
      : null

  const { cmd, args } = serverCommand({
    repo,
    dataDir,
    port,
    env,
    terminals: sidecar?.address,
    args: extraArgs
  })
  const serverEnv = sidecar ? { ...env, CLAVE_TERMINALS_TOKEN: sidecar.token } : env
  const { child, announced, stderr } = startAnnouncing({
    what: 'the server',
    cmd,
    args,
    cwd: repo,
    env: serverEnv,
    timeoutMs,
    fields: ['url', 'token']
  })
  let settled
  try {
    settled = await announced
  } catch (err) {
    await sidecar?.stop()
    throw err
  }

  let exited = false
  child.once('exit', () => {
    exited = true
  })

  return {
    url: settled.url,
    token: settled.token,
    pid: child.pid,
    dataDir,
    stderr: () => stderr() + (sidecar ? `\n[terminal process]\n${sidecar.stderr()}` : ''),
    terminalProcess: sidecar,
    stop: async () => {
      if (!exited) await stopChild(child, killAfterMs)
      await sidecar?.stop()
    }
  }
}
