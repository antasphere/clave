/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, shared by the dev script and the e2e harness */
// The server as its own process, started from a checkout (ADR 0003).
//
// ONE place names the command, for the dev script (scripts/dev-attached.mjs)
// and the e2e harness (tests/e2e/harness.mjs) alike. Today the command runs
// the placeholder entry `src/main/server-entry.ts` under Bun, which runs the
// TypeScript as it is; when lane A's `packages/server` merges, `serverCommand`
// points at that package's own entry under whatever runtime it chose, and
// nothing that calls it changes. The contract that stays: the process binds
// 127.0.0.1, and prints ONE JSON line `{"url","token"}` on stdout once it
// listens.
//
// Nothing here listens on, or upgrades, the server's port: the push channel
// is a WebSocket upgrade on that same port (lane A), and a second handler
// there corrupts frames.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Where `bun` is: `CLAVE_BUN`, then the PATH, then the default install. */
export function bunBinary(env = process.env) {
  if (env.CLAVE_BUN) return env.CLAVE_BUN
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, 'bun'))) return path.join(dir, 'bun')
  }
  const home = path.join(os.homedir(), '.bun', 'bin', 'bun')
  if (existsSync(home)) return home
  throw new Error(
    'bun was not found (CLAVE_BUN, the PATH, ~/.bun/bin/bun). The server entry runs under Bun: https://bun.sh'
  )
}

/** The command line that starts the server on `dataDir`, port 0 = any free. */
export function serverCommand({ repo, dataDir, port = 0, env = process.env }) {
  return {
    cmd: bunBinary(env),
    args: [
      path.join(repo, 'src', 'main', 'server-entry.ts'),
      '--data-dir',
      dataDir,
      '--port',
      String(port)
    ]
  }
}

/**
 * Start the server and resolve once it announced itself. Rejects when it
 * exits first or stays silent past `timeoutMs`, with its stderr in the
 * message. `stop()` sends SIGTERM and waits, SIGKILL after `killAfterMs`.
 */
export async function startServerProcess({
  repo,
  dataDir,
  port = 0,
  timeoutMs = 15_000,
  killAfterMs = 5_000,
  env = process.env
}) {
  mkdirSync(dataDir, { recursive: true })
  const { cmd, args } = serverCommand({ repo, dataDir, port, env })
  const child = spawn(cmd, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })

  // A child that never announces itself (a timeout, an unreadable line, an
  // exit) is stopped HERE before the rejection: nobody else holds its pid,
  // so nothing else could sweep it, and a late server would otherwise live
  // on past the run on a random port with its token on disk. The rejection
  // carries `pid` for the record.
  const announced = await new Promise((resolve, reject) => {
    let out = ''
    let settled = false
    const done = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (fn === reject) {
        if (value instanceof Error) value.pid = child.pid
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
      fn(value)
    }
    const timer = setTimeout(
      () =>
        done(reject, new Error(`the server did not announce itself in ${timeoutMs}ms\n${stderr}`)),
      timeoutMs
    )
    child.stdout.on('data', (d) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl < 0) return
      const line = out.slice(0, nl)
      try {
        const parsed = JSON.parse(line)
        if (typeof parsed?.url !== 'string' || typeof parsed?.token !== 'string')
          throw new Error('url and token expected')
        done(resolve, parsed)
      } catch (err) {
        done(reject, new Error(`unreadable server announcement "${line}": ${err.message}`))
      }
    })
    child.once('error', (err) => done(reject, new Error(`could not start ${cmd}: ${err.message}`)))
    child.once('exit', (code, signal) =>
      done(
        reject,
        new Error(`the server exited (${code ?? signal}) before announcing itself\n${stderr}`)
      )
    )
  })

  let exited = false
  child.once('exit', () => {
    exited = true
  })

  return {
    url: announced.url,
    token: announced.token,
    pid: child.pid,
    dataDir,
    stderr: () => stderr,
    stop: () =>
      new Promise((resolve) => {
        if (exited) return resolve()
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
}
