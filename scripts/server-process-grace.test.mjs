import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_KILL_GRACE_MS, startServerProcess } from './server-process.mjs'

// The kill grace's cap. A child that never announced itself is killed before
// the rejection, and the rejection waits for its exit, but never longer than
// ANNOUNCE_KILL_GRACE_MS. A real process always dies on SIGKILL, so the fakes
// of scripts/server-process-budgets.test.mjs never reach the cap. Here `spawn`
// itself is stood in for, in this file alone, by a child whose kill does not
// land: kill() answers false, as it does on EPERM, and no exit ever comes. No
// process starts here.

const spawned = vi.hoisted(() => [])

vi.mock('node:child_process', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const { PassThrough: Pipe } = await import('node:stream')
  return {
    spawn: () => {
      const child = new Emitter()
      child.stdout = new Pipe()
      child.stderr = new Pipe()
      child.pid = 2147483000
      child.exitCode = null
      child.signalCode = null
      child.kill = vi.fn(() => false)
      spawned.push(child)
      return child
    }
  }
})

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT_MS = 50

describe("the kill grace's cap", () => {
  let dir = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it(
    'a child whose kill never lands is still rejected, once the grace runs out',
    async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'clave-server-grace-'))
      const began = Date.now()
      const err = await startServerProcess({
        repo: REPO,
        dataDir: path.join(dir, 'data'),
        terminals: 'none',
        timeoutMs: TIMEOUT_MS,
        env: { CLAVE_BUN: '/nonexistent/stand-in-bun' }
      }).catch((e) => e)
      const took = Date.now() - began
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/the server did not announce itself in 50ms/)
      expect(err.pid).toBe(2147483000)
      expect(spawned).toHaveLength(1)
      expect(spawned[0].kill).toHaveBeenCalledWith('SIGKILL')
      expect(took).toBeGreaterThanOrEqual(TIMEOUT_MS + ANNOUNCE_KILL_GRACE_MS - 100)
      expect(took).toBeLessThan(TIMEOUT_MS + ANNOUNCE_KILL_GRACE_MS + 1_000)
    },
    TIMEOUT_MS + ANNOUNCE_KILL_GRACE_MS + 3_000
  )
})
