import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeReports } from './merge-reports.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
function invoke(script, args, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
      env: {
        ...process.env,
        CLAVE_E2E_SPECS_DIR: dir,
        CLAVE_E2E_SERVER: 'in-process',
        CLAVE_E2E_NS: `clave-e2e-sharding-test-${path.basename(dir)}`
      }
    })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, output }))
  })
}
function fixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clave-sharding-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body)
  return dir
}
const passing = `export async function run(t) { t.check('ran', true, process.env.CLAVE_E2E_NS) }`

describe('the real runner process shards without hiding failures', () => {
  it('reports exactly the selected specs, including an empty shard', async () => {
    const dir = fixture({ 'a.spec.mjs': passing, 'b.spec.mjs': passing })
    try {
      const reports = []
      for (let index = 1; index <= 3; index++) {
        const file = path.join(dir, `shard-${index}.json`)
        const result = await invoke('run.mjs', ['--shard', `${index}/3`, '--report', file], dir)
        expect(result.code, result.output).toBe(0)
        reports.push(JSON.parse(readFileSync(file, 'utf8')))
      }
      expect(mergeReports(reports, ['a.spec.mjs', 'b.spec.mjs'], 3).specs).toBe(2)
      expect(reports[2].selected).toEqual([])
      expect(reports[0].results['a.spec.mjs'][0].detail).not.toBe(
        reports[1].results['b.spec.mjs'][0].detail
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
  it('lists filters without running specs and rejects invalid options', async () => {
    const dir = fixture({ 'a.spec.mjs': 'throw new Error("must not import")' })
    try {
      const result = await invoke('run.mjs', ['a.spec', '--list'], dir)
      expect(result.code).toBe(0)
      expect(JSON.parse(result.output)).toEqual(['a.spec.mjs'])
      expect((await invoke('run.mjs', ['--shard=0/8'], dir)).code).not.toBe(0)
      expect((await invoke('run.mjs', ['no-matching-spec'], dir)).code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
  it('parallel runs preserve failing assertions and empty-spec failures', async () => {
    const dir = fixture({
      'a.spec.mjs': passing,
      'b.spec.mjs': `export async function run(t) { t.check('intentional failure', false) }`,
      'c.spec.mjs': 'export async function run() {}'
    })
    try {
      const result = await invoke('parallel.mjs', ['--workers=2'], dir)
      expect(result.code, result.output).toBe(1)
      expect(result.output).toContain('"failed":2')
      expect(result.output).toContain('3 specs;')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
  it('a crashed worker cannot produce a successful parallel run', async () => {
    const dir = fixture({
      'a.spec.mjs': passing,
      'b.spec.mjs': 'export async function run() { process.exit(7) }'
    })
    try {
      const result = await invoke('parallel.mjs', ['--workers=2'], dir)
      expect(result.code).not.toBe(0)
      expect(result.output).toContain('worker did not complete')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
  it('rejects an exit code that suppresses a failed assertion', () => {
    const report = {
      version: 1,
      completed: true,
      shard: { index: 1, total: 1 },
      mode: 'in-process',
      selected: ['a.spec.mjs'],
      results: { 'a.spec.mjs': [{ name: 'failed', ok: false }] },
      exitCode: 0
    }
    expect(() => mergeReports([report], ['a.spec.mjs'], 1)).toThrow('exit code disagrees')
    expect(mergeReports([{ ...report, exitCode: 1 }], ['a.spec.mjs'], 1).totals.failed).toBe(1)
  })
})
