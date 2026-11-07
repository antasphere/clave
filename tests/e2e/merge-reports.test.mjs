import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectShard } from './sharding.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const all = readdirSync(HERE)
  .filter((f) => f.endsWith('.spec.mjs'))
  .sort()
// Synthetic reports test the CLI's inventory boundary, without launching apps.
function withReports(specs, run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clave-merge-reports-'))
  try {
    for (let index = 1; index <= 4; index++) {
      const selected = selectShard(specs, { index, total: 4 })
      writeFileSync(
        path.join(dir, `shard-${index}.json`),
        JSON.stringify({
          version: 1,
          completed: true,
          shard: { index, total: 4 },
          mode: 'in-process',
          selected,
          results: Object.fromEntries(
            selected.map((s) => [s, [{ name: 'synthetic inventory assertion', ok: true }]])
          ),
          exitCode: 0
        })
      )
    }
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
function cli(dir, output = null) {
  return spawnSync(
    process.execPath,
    [path.join(HERE, 'merge-reports.mjs'), dir, '4', ...(output ? [output] : [])],
    {
      encoding: 'utf8',
      timeout: 10_000
    }
  )
}

describe('the required-check report CLI', () => {
  it('names failed checks in stdout and the summary while retaining report policy', () =>
    withReports(all, (dir) => {
      const file = path.join(dir, 'shard-1.json')
      const report = JSON.parse(readFileSync(file, 'utf8'))
      report.results[report.selected[0]][0] = { name: 'synthetic failed assertion', ok: false }
      report.exitCode = 1
      writeFileSync(file, JSON.stringify(report))
      const summary = path.join(dir, 'summary.md')
      const result = cli(dir, summary)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain(`FAIL ${report.selected[0]}: synthetic failed assertion`)
      expect(readFileSync(summary, 'utf8')).toContain(
        `${report.selected[0]}: synthetic failed assertion`
      )
    }))
  it('accepts the complete repository inventory', () =>
    withReports(all, (dir) => {
      const result = cli(dir)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain(`${all.length} specs;`)
    }))
  it('rejects a self-consistent subset, using the checkout as its independent inventory', () =>
    withReports(all.slice(0, 8), (dir) => {
      const result = cli(dir)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('omitted or added specs')
    }))
  it('rejects a missing report even if the remaining reports are valid', () =>
    withReports(all, (dir) => {
      rmSync(path.join(dir, 'shard-2.json'))
      const result = cli(dir)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('expected 4 reports, got 3')
    }))
})
