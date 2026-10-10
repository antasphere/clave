// The harness's synchronous child calls are bounded (PRDCT-3375): a tmux or
// an lsof that hangs would block the runner's own event loop, the one shape
// no in-process deadline can catch. A tmux of the test's own, on its PATH,
// sleeps longer than the timeout; the call must return at the timeout.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
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

describe('the cleanup keeps tmux on the child’s PATH', () => {
  it('an env naming only the namespace still finds tmux: the child gets the process environment under it', () => {
    // The full in-process suite on be930bb failed namespace.spec.mjs three
    // times: the cleanup passed the spec's bare `{ CLAVE_E2E_NS }` to the
    // child, which then had no PATH and no tmux.
    const dir = fakeBin('tmux', 'echo "" >&2; exit 0')
    const saved = process.env.PATH
    process.env.PATH = `${dir}:${saved}`
    try {
      // Bare env: the fake tmux on the PROCESS PATH must be the one found,
      // which only happens when the process environment reaches the child.
      const marker = path.join(dir, 'seen')
      writeFileSync(path.join(dir, 'tmux'), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`)
      killLeakedE2eTmux({ env: { CLAVE_E2E_NS: 'clave-e2e-env-merge' }, timeoutMs: 2000 })
      expect(existsSync(marker)).toBe(true)
    } finally {
      process.env.PATH = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
