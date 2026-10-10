// The harness's synchronous child calls are bounded (PRDCT-3375): a tmux or
// an lsof that hangs would block the runner's own event loop, the one shape
// no in-process deadline can catch. A tmux of the test's own, on its PATH,
// sleeps longer than the timeout; the call must return at the timeout.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { killLeakedE2eTmux, tmuxSessionAlive } from './harness.mjs'

function fakeTmux(seconds) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clave-fake-tmux-'))
  const file = path.join(dir, 'tmux')
  writeFileSync(file, `#!/bin/sh\nsleep ${seconds}\n`)
  chmodSync(file, 0o755)
  return dir
}

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
