/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test of a plain JS script */
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANNOUNCE_KILL_GRACE_MS,
  ANNOUNCE_TIMEOUT_MS,
  STOP_KILL_AFTER_MS,
  startServerProcess
} from './server-process.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The budgets scripts/server-process.test.mjs derives its boot test's timeout
// from, proved real on fakes. `CLAVE_BUN` names what the starter runs the
// server entry under, so a script standing in for Bun ignores the entry and
// its flags and behaves as a budget's worst case: one never announces itself,
// one announces and then ignores SIGTERM. No server boots here, so this file
// runs anywhere the unit tests run.

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A stand-in for Bun: a shell script that runs `body` under this Node. */
function fakeBun(dir, name, body) {
  const file = path.join(dir, name)
  writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e '${body}'\n`)
  chmodSync(file, 0o755)
  return file
}

describe('the budgets a boot test is derived from', () => {
  let dir = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('the defaults are the three the starter exports', () => {
    expect(ANNOUNCE_TIMEOUT_MS).toBe(15_000)
    expect(ANNOUNCE_KILL_GRACE_MS).toBe(2_000)
    expect(STOP_KILL_AFTER_MS).toBe(5_000)
  })

  it('a server that never announces itself is rejected, and already dead, within the announce budget and its grace', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'clave-server-budgets-'))
    const silent = fakeBun(dir, 'bun-silent', 'setInterval(() => {}, 1000)')
    const began = Date.now()
    const err = await startServerProcess({
      repo: REPO,
      dataDir: path.join(dir, 'data'),
      terminals: 'none',
      timeoutMs: 300,
      env: { ...process.env, CLAVE_BUN: silent }
    }).catch((e) => e)
    const took = Date.now() - began
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/the server did not announce itself in 300ms/)
    expect(typeof err.pid).toBe('number')
    expect(alive(err.pid)).toBe(false)
    expect(took).toBeLessThan(300 + ANNOUNCE_KILL_GRACE_MS + 1_000)
  })

  it('a server that ignores SIGTERM is gone within the stop budget, and stop() waits no longer', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'clave-server-budgets-'))
    const stalling = fakeBun(
      dir,
      'bun-stalling',
      'process.on("SIGTERM", () => {}); process.stdout.write(JSON.stringify({ url: "http://127.0.0.1:1", token: "ab".repeat(32) }) + "\\n"); setInterval(() => {}, 1000)'
    )
    const server = await startServerProcess({
      repo: REPO,
      dataDir: path.join(dir, 'data'),
      terminals: 'none',
      killAfterMs: 500,
      env: { ...process.env, CLAVE_BUN: stalling }
    })
    expect(server.url).toBe('http://127.0.0.1:1')
    expect(alive(server.pid)).toBe(true)
    const began = Date.now()
    await server.stop()
    const took = Date.now() - began
    expect(alive(server.pid)).toBe(false)
    // SIGTERM was ignored, so the exit came from the SIGKILL at killAfterMs.
    expect(took).toBeGreaterThanOrEqual(400)
    expect(took).toBeLessThan(500 + 1_500)
  })
})
