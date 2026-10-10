// The runner gives every spec a deadline (PRDCT-3375): run.mjs is started as
// a process on a folder of two specs, one that never returns with a short
// deadline of its own and one after it, and must fail the first, run the
// second and finish. Before the change the runner awaited `run(t)` for ever.
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(HERE, 'run.mjs')

function runRunner(specsDir, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER], {
      cwd: path.resolve(HERE, '..', '..'),
      env: {
        ...process.env,
        CLAVE_E2E_SPECS_DIR: specsDir,
        CLAVE_E2E_NS: `clave-e2e-runner-test-${process.pid}`,
        CLAVE_E2E_SERVER: 'in-process',
        ...env
      }
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.once('close', (code) => resolve({ code, out }))
  })
}

describe('the runner bounds every spec', () => {
  it('a spec that never returns fails within its deadline and the run goes on', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clave-runner-deadline-'))
    try {
      writeFileSync(
        path.join(dir, 'a-hang.spec.mjs'),
        `export const deadlineMs = 400
export async function run(t) {
  t.check('the hanging spec started', true)
  await new Promise(() => {})
  t.check('never reached', true)
}
`
      )
      writeFileSync(
        path.join(dir, 'b-after.spec.mjs'),
        `export async function run(t) { t.check('the spec after the hang ran', true) }
`
      )
      const started = Date.now()
      const { code, out } = await runRunner(dir)
      expect(Date.now() - started).toBeLessThan(30_000)
      expect(code).toBe(1)
      expect(out).toContain('a-hang.spec.mjs finished within its deadline')
      expect(out).toContain('400 ms passed')
      expect(out).toContain('the spec after the hang ran')
      expect(out).toMatch(/2 passed, 1 failed/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('a late check from the dead spec is printed as LATE and counted nowhere', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clave-runner-late-'))
    try {
      writeFileSync(
        path.join(dir, 'a-late.spec.mjs'),
        `export const deadlineMs = 300
export async function run(t) {
  await new Promise((r) => setTimeout(r, 900))
  t.check('a check after the deadline', false, 'would be a failure if counted')
}
`
      )
      writeFileSync(
        path.join(dir, 'b-slow.spec.mjs'),
        `export async function run(t) {
  await new Promise((r) => setTimeout(r, 1200))
  t.check('the next spec, still running when the late check lands', true)
}
`
      )
      const { code, out } = await runRunner(dir)
      expect(code).toBe(1)
      expect(out).toContain('LATE')
      expect(out).toContain('a check after the deadline  (after the deadline, not counted)')
      // One failure only: the deadline's. The late check added none.
      expect(out).toMatch(/1 passed, 1 failed/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('the environment sets the deadline when a spec names none', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clave-runner-env-'))
    try {
      writeFileSync(
        path.join(dir, 'hang.spec.mjs'),
        `export async function run(t) { t.check('started', true); await new Promise(() => {}) }
`
      )
      const { code, out } = await runRunner(dir, { CLAVE_E2E_SPEC_DEADLINE_MS: '350' })
      expect(code).toBe(1)
      expect(out).toContain('350 ms passed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
