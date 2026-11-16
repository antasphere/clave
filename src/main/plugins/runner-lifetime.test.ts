import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A forked plugin runner ends with its server (PRDCT-4471), with the REAL
 * runner: a parent forks `plugin-runner.ts` the way the standalone server
 * does (`fork-runner.ts`, Node IPC), with a fixture plugin whose `activate`
 * keeps the event loop alive (a listening server), waits for the plugin to
 * be ready, and is then killed with SIGKILL, which runs no cleanup of its
 * own. The runner must be gone within three seconds.
 *
 * The parent and the runner run under the repository's Bun, the way
 * `npm run dev:server` runs the server from its sources: Bun runs the
 * runner's TypeScript and resolves `@clave/plugin-sdk` from the workspace,
 * with no build. Skipped where that Bun is not installed.
 */
const root = join(__dirname, '..', '..', '..')
const BUN = join(root, 'node_modules', '.bin', 'bun')
const RUNNER = join(__dirname, 'plugin-runner.ts')

const PLUGIN = `
import { createServer } from 'node:http'
export default {
  activate() {
    createServer((_req, res) => res.end('ok')).listen(0, '127.0.0.1')
  }
}
`

/** Forks the runner as the standalone server does, says its pid once the plugin is ready. */
const PARENT = `
import { fork } from 'node:child_process'
const [runner, main] = process.argv.slice(2)
const child = fork(runner, [], {
  execPath: process.execPath,
  serialization: 'json',
  stdio: ['ignore', 'inherit', 'inherit', 'ipc']
})
child.on('message', (message) => {
  if (message && message.method === 'plugin.ready') process.stdout.write(JSON.stringify({ pid: child.pid }) + '\\n')
  if (message && message.method === 'plugin.failed') process.stderr.write(JSON.stringify(message) + '\\n')
})
child.send({ main })
setInterval(() => {}, 1000)
`

const dirs: string[] = []
const pids: number[] = []
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!existsSync(BUN))('a forked plugin runner and its server', () => {
  it('ends within three seconds of its server being killed with SIGKILL, though its plugin keeps the loop busy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clave-runner-lifetime-'))
    dirs.push(dir)
    const main = join(dir, 'main.mjs')
    writeFileSync(main, PLUGIN)
    const parentFile = join(dir, 'parent.mjs')
    writeFileSync(parentFile, PARENT)
    const parent = spawn(BUN, [parentFile, RUNNER, main], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    pids.push(parent.pid!)
    const runnerPid = await new Promise<number>((resolve, reject) => {
      let errors = ''
      const timer = setTimeout(
        () => reject(new Error(`the plugin did not become ready: ${errors}`)),
        15_000
      )
      parent.stderr.on('data', (chunk) => (errors += String(chunk)))
      parent.on('exit', () => reject(new Error(`the parent ended: ${errors}`)))
      parent.stdout.on('data', (chunk) => {
        clearTimeout(timer)
        resolve((JSON.parse(String(chunk).trim().split('\n')[0]!) as { pid: number }).pid)
      })
    })
    pids.push(runnerPid)
    expect(alive(runnerPid)).toBe(true)
    parent.kill('SIGKILL')
    await expect.poll(() => alive(runnerPid), { timeout: 3_000, interval: 50 }).toBe(false)
  }, 25_000)
})
