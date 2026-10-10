// The harness's synchronous child calls are bounded (PRDCT-3375): a tmux or
// an lsof that hangs would block the runner's own event loop, the one shape
// no in-process deadline can catch. A tmux of the test's own, on its PATH,
// sleeps longer than the timeout; the call must return at the timeout.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fixtureRoot } from './namespace.mjs'
import { killLeakedE2eTmux, listeningPorts, tmuxSessionAlive } from './harness.mjs'

/** A folder holding one fake command `name` with the given sh body. */
function fakeBin(name, body) {
  const dir = mkdtempSync(path.join(tmpdir(), `clave-fake-${name}-`))
  const file = path.join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return dir
}
const fakeTmux = (seconds) => fakeBin('tmux', `sleep ${seconds}`)

describe('a hung tmux does not hold the harness', () => {
  it('killLeakedE2eTmux returns at its timeout, not at the child’s leisure', () => {
    const dir = fakeTmux(5)
    try {
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` }
      const started = Date.now()
      killLeakedE2eTmux({ env, timeoutMs: 300 })
      const took = Date.now() - started
      expect(took).toBeLessThan(2500)
      expect(took).toBeGreaterThanOrEqual(250)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a kill-session that hangs is bounded too, after a list that named a leaked session', () => {
    // The fake tmux answers list-sessions with one row under this run's
    // fixture root, and sleeps on the kill-session that follows.
    const env = { ...process.env }
    const root = fixtureRoot({ env })
    const dir = fakeBin(
      'tmux',
      `case "$*" in *list-sessions*) echo "clave-e2e-hung|${root}/x";; *kill-session*) sleep 5;; esac`
    )
    try {
      env.PATH = `${dir}:${env.PATH}`
      const started = Date.now()
      killLeakedE2eTmux({ env, timeoutMs: 300 })
      expect(Date.now() - started).toBeLessThan(2500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an lsof that hangs ends in a thrown timeout at the bound, never a wait', () => {
    const dir = fakeBin('lsof', 'sleep 5')
    try {
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` }
      const started = Date.now()
      expect(() => listeningPorts(process.pid, { timeoutMs: 300, env })).toThrow()
      expect(Date.now() - started).toBeLessThan(2500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tmuxSessionAlive answers false at its timeout rather than waiting', () => {
    const dir = fakeTmux(5)
    const saved = process.env.PATH
    process.env.PATH = `${dir}:${saved}`
    try {
      const started = Date.now()
      expect(tmuxSessionAlive('clave-e2e-never', { timeoutMs: 300 })).toBe(false)
      expect(Date.now() - started).toBeLessThan(2500)
    } finally {
      process.env.PATH = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
