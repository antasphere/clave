import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeReports } from './merge-reports.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let reportAttempt = 0
function invoke(script, args, dir, automaticReports = true) {
  if (
    automaticReports &&
    script === 'parallel.mjs' &&
    !args.some((a) => a.startsWith('--report-dir='))
  )
    args = [...args, `--report-dir=${path.join(dir, `reports-${++reportAttempt}`)}`]
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
  it('removes successful implicit reports but retains failed-run diagnostics', async () => {
    const dir = fixture({ 'a.spec.mjs': passing })
    let retained
    try {
      const green = await invoke('parallel.mjs', ['--workers=1'], dir, false)
      expect(green.code, green.output).toBe(0)
      const removed = green.output.match(/logs and reports: (.+)/)[1].trim()
      expect(existsSync(removed)).toBe(false)
      writeFileSync(
        path.join(dir, 'a.spec.mjs'),
        `export async function run(t) { t.check('failed', false) }`
      )
      const red = await invoke('parallel.mjs', ['--workers=1'], dir, false)
      expect(red.code, red.output).toBe(1)
      retained = red.output.match(/logs and reports: (.+)/)[1].trim()
      expect(path.dirname(retained)).toBe(path.resolve(tmpdir()))
      expect(path.basename(retained).startsWith('clave-e2e-parallel-')).toBe(true)
      expect(existsSync(path.join(retained, 'shard-1.json'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (
        retained &&
        path.dirname(retained) === path.resolve(tmpdir()) &&
        path.basename(retained).startsWith('clave-e2e-parallel-')
      )
        rmSync(retained, { recursive: true, force: true })
    }
  }, 30_000)
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
  it('defaults to one local worker with the original complete selection', async () => {
    const dir = fixture({ 'a.spec.mjs': passing, 'b.spec.mjs': passing })
    const reports = path.join(dir, 'reports')
    try {
      const result = await invoke('parallel.mjs', [`--report-dir=${reports}`], dir)
      expect(result.code, result.output).toBe(0)
      const report = JSON.parse(readFileSync(path.join(reports, 'shard-1.json'), 'utf8'))
      expect(report.shard).toEqual({ index: 1, total: 1 })
      expect(report.selected).toEqual(['a.spec.mjs', 'b.spec.mjs'])
      expect(existsSync(path.join(reports, 'shard-2.json'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
  it('refuses OS exits that disagree with otherwise valid local reports', async () => {
    for (const failed of [false, true]) {
      const dir = fixture({
        'a.spec.mjs': `export async function run(t) {
          process.on('exit', () => { process.exitCode = ${failed ? 0 : 1} })
          t.check('recorded assertion', ${!failed})
        }`
      })
      try {
        const result = await invoke('parallel.mjs', ['--workers=1'], dir)
        expect(result.code, result.output).not.toBe(0)
        expect(result.output).toContain('status disagrees with its report')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
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
      expect(result.output).toContain('FAIL b.spec.mjs: intentional failure')
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
  it('writes CI reports to an explicit directory and refuses stale results', async () => {
    const dir = fixture({ 'a.spec.mjs': passing })
    const reports = path.join(dir, 'reports')
    try {
      const result = await invoke('parallel.mjs', ['--workers=1', `--report-dir=${reports}`], dir)
      expect(result.code, result.output).toBe(0)
      expect(JSON.parse(readFileSync(path.join(reports, 'shard-1.json'), 'utf8')).completed).toBe(
        true
      )
      const stale = await invoke('parallel.mjs', ['--workers=1', `--report-dir=${reports}`], dir)
      expect(stale.code).not.toBe(0)
      expect(stale.output).toContain('Report directory must be empty')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
  it('simultaneous parallel runs from this checkout have distinct fixture namespaces', async () => {
    const dir = fixture({ 'a.spec.mjs': passing, 'b.spec.mjs': passing })
    try {
      const folders = [path.join(dir, 'one'), path.join(dir, 'two')]
      const results = await Promise.all(
        folders.map((folder) =>
          invoke('parallel.mjs', ['--workers=2', `--report-dir=${folder}`], dir)
        )
      )
      expect(results.map((r) => r.code)).toEqual([0, 0])
      const namespaces = folders.flatMap((folder) =>
        [1, 2].map((index) => {
          const report = JSON.parse(readFileSync(path.join(folder, `shard-${index}.json`), 'utf8'))
          return Object.values(report.results)[0][0].detail
        })
      )
      expect(new Set(namespaces).size).toBe(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
  it('SIGTERM is a failing exit even when the spec has already asserted', async () => {
    const dir = fixture({
      'a.spec.mjs': `export async function run(t) { t.check('signal-ready', true); await new Promise(() => {}) }`
    })
    let child
    try {
      const result = await new Promise((resolve, reject) => {
        child = spawn(process.execPath, [path.join(HERE, 'run.mjs')], {
          env: {
            ...process.env,
            CLAVE_E2E_SPECS_DIR: dir,
            CLAVE_E2E_SERVER: 'in-process',
            CLAVE_E2E_NS: `clave-e2e-signal-${path.basename(dir)}`
          }
        })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('signal cleanup did not finish'))
        }, 10_000)
        let output = ''
        let signalled = false
        child.stdout.on('data', (chunk) => {
          output += chunk
          if (!signalled && output.includes('signal-ready')) {
            signalled = true
            child.kill('SIGTERM')
          }
        })
        child.stderr.resume()
        child.once('error', reject)
        child.once('close', (code) => {
          clearTimeout(timer)
          resolve({ code, output })
        })
      })
      expect(result.code, result.output).toBe(143)
    } finally {
      child?.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
