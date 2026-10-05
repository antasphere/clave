/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test of a plain JS script */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServerProcess } from './server-process.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const untilDead = async (pid, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !alive(pid)
}

describe('the server as its own process', () => {
  it('announces itself, writes an owner-only discovery file, and takes both away when stopped', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-process-'))
    try {
      const server = await startServerProcess({ repo: REPO, dataDir })
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(server.token).toMatch(/^[0-9a-f]{64}$/)
      const file = path.join(dataDir, 'clave-server.json')
      expect(existsSync(file)).toBe(true)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200)

      await server.stop()
      expect(await untilDead(server.pid)).toBe(true)
      expect(existsSync(file)).toBe(false)
      await expect(fetch(`${server.url}/health/live`)).rejects.toThrow()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('a server that misses its announce timeout is killed, not left running', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-process-late-'))
    try {
      const err = await startServerProcess({ repo: REPO, dataDir, timeoutMs: 1 }).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/did not announce itself/)
      expect(typeof err.pid).toBe('number')
      // Gone AT the rejection, not some time after: a caller that removes its
      // data directory on the rejection must find nothing still writing there.
      expect(alive(err.pid)).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
