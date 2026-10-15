import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(
  new URL('../../scripts/performance/renderer-benchmark.mjs', import.meta.url)
)
test('invalid workloads exit nonzero before launching Electron or making artifacts', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'renderer-cli-'))
  try {
    for (const args of [
      ['--samples', '0'],
      ['--tabs', '7'],
      ['--runs', 'NaN'],
      ['--build', 'typo'],
      ['--unknown']
    ]) {
      const out = path.join(dir, 'output')
      const r = spawnSync(process.execPath, [script, '--out', out, ...args], {
        encoding: 'utf8',
        timeout: 10_000
      })
      assert.equal(r.error, undefined)
      assert.equal(r.status, 1, r.stderr)
      assert.equal(existsSync(out), false)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
