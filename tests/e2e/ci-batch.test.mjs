import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeReports } from './merge-reports.mjs'
import { CLIPBOARD_SPECS, selectShard } from './sharding.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const passing = `export async function run(t) {
  await new Promise(r => setTimeout(r, 80))
  t.check('namespace', true, process.env.CLAVE_E2E_NS)
  t.check('step output belongs to coordinator', process.env.GITHUB_OUTPUT === undefined)
}`
function fixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clave-ci-batch-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body)
  return dir
}
function launch(dir, host, name = host.replace('/', '-'), args = null) {
  const reports = path.join(dir, `reports-${name}`)
  const output = path.join(dir, `output-${name}`)
  const child = spawn(
    process.execPath,
    [path.join(HERE, 'ci-batch.mjs'), ...(args ?? [host, `--report-dir=${reports}`])],
    {
      env: {
        ...process.env,
        CLAVE_E2E_SPECS_DIR: dir,
        CLAVE_E2E_SERVER: 'in-process',
        GITHUB_OUTPUT: output
      }
    }
  )
  let text = ''
  child.stdout.on('data', (d) => {
    text += d
  })
  child.stderr.on('data', (d) => {
    text += d
  })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, text, reports, output }))
  })
  return { child, done, reports, output }
}
function reportsAt(dir) {
  return readdirSync(dir)
    .filter((n) => /^shard-\d+\.json$/.test(n))
    .map((n) => JSON.parse(readFileSync(path.join(dir, n), 'utf8')))
}
function completed(file) {
  return existsSync(file) && readFileSync(file, 'utf8').includes('complete=true')
}

describe('hosted worker batches', () => {
  it('runs all five global shards exactly once with independent worker namespaces', async () => {
    const names = [
      ...CLIPBOARD_SPECS,
      ...Array.from({ length: 15 }, (_, i) => `probe-${i}.spec.mjs`)
    ].sort()
    const dir = fixture(Object.fromEntries(names.map((n) => [n, passing])))
    try {
      const batches = await Promise.all(
        ['1/5', '2/5', '3/5', '4/5', '5/5'].map((host) => launch(dir, host).done)
      )
      expect(
        batches.map((b) => b.code),
        batches.map((b) => b.text).join('\n')
      ).toEqual([0, 0, 0, 0, 0])
      const reports = batches.flatMap((b) => reportsAt(b.reports))
      expect(reports.map((r) => r.shard.index).sort()).toEqual([1, 2, 3, 4, 5])
      expect(mergeReports(reports, names, 5).specs).toBe(names.length)
      const namespaces = []
      for (const report of reports) {
        expect(report.shard.total).toBe(5)
        expect(report.selected).toEqual(selectShard(names, report.shard))
        if (report.selected.some((n) => CLIPBOARD_SPECS.has(n))) expect(report.shard.index).toBe(1)
        if (report.selected.length) namespaces.push(report.results[report.selected[0]][0].detail)
      }
      expect(new Set(namespaces).size).toBe(5)
      for (const [i, batch] of batches.entries()) {
        expect(completed(batch.output)).toBe(true)
        const resource = JSON.parse(
          readFileSync(path.join(batch.reports, `resources-host-${i + 1}.json`), 'utf8')
        )
        expect(resource.completed).toBe(true)
        expect(resource.workers).toBe(1)
        expect(resource.globalShards).toBe(5)
        expect(resource.workerOutcomes).toHaveLength(1)
        expect(resource.workerOutcomes.map((w) => w.index)).toEqual([i + 1])
        expect(resource.totalMemoryBytes).toBeGreaterThan(0)
        expect(resource.samples).toBeGreaterThan(0)
        expect(resource.maxSampledRssKiB).toBeGreaterThan(0)
        expect(resource.samplingErrors).toEqual([])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps FAIL, KNOWN and UNSTABLE labels while attesting completed work', async () => {
    const known = JSON.parse(readFileSync(path.join(HERE, 'known-failures.json'), 'utf8'))
    const [file, checks] = Object.entries(known.specs).find(([, checks]) => checks.length)
    const unstable = known.unstable.find((name) => name !== file)
    const files = {
      'probe-failure.spec.mjs': `export async function run(t) { t.check('ordinary failure', false) }`,
      [file]: `export async function run(t) { t.check(${JSON.stringify(checks[0])}, false) }`,
      [unstable]: `export async function run(t) { t.check('unstable failure', false) }`
    }
    const dir = fixture(files)
    try {
      const batches = await Promise.all(
        ['1/5', '2/5', '3/5', '4/5', '5/5'].map((host) => launch(dir, host).done)
      )
      expect(batches.some((b) => b.code === 1)).toBe(true)
      expect(batches.every((b) => completed(b.output))).toBe(true)
      const text = batches.map((b) => b.text).join('\n')
      expect(text).toContain('FAIL probe-failure.spec.mjs: ordinary failure')
      expect(text).toContain(`KNOWN ${file}: ${checks[0]}`)
      expect(text).toContain(`UNSTABLE ${unstable}: unstable failure`)
      const merged = mergeReports(
        batches.flatMap((b) => reportsAt(b.reports)),
        Object.keys(files).sort(),
        5
      )
      expect(merged.totals.failed).toBe(1)
      expect(merged.totals.known).toBe(1)
      expect(merged.totals.unstable).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('refuses an early crash and a late nonzero OS exit after a valid report', async () => {
    for (const late of [false, true]) {
      const body = late
        ? `import {appendFileSync} from 'node:fs'
        export async function run(t) {
          if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'complete=true\\n')
          process.on('exit', () => { process.exitCode = 7 })
          t.check('ran', true)
        }`
        : `export async function run() { process.exit(7) }`
      const dir = fixture({ 'probe.spec.mjs': body })
      try {
        const result = await launch(dir, '1/5').done
        expect(result.code, result.text).not.toBe(0)
        expect(result.text).toContain('worker did not complete')
        expect(completed(result.output)).toBe(false)
        if (late) {
          const report = JSON.parse(readFileSync(path.join(result.reports, 'shard-1.json'), 'utf8'))
          expect(report.completed).toBe(true)
          expect(report.exitCode).toBe(0)
          // Even a complete-looking artifact cannot replace the process-status gate.
          const resource = JSON.parse(
            readFileSync(path.join(result.reports, 'resources-host-1.json'), 'utf8')
          )
          expect(resource.workerOutcomes.some((w) => w.code === 7)).toBe(true)
          expect(resource.completed).toBe(false)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 30_000)

  it('rejects a worker that exits zero after reporting a failed assertion', async () => {
    const dir = fixture({
      'probe.spec.mjs': `export async function run(t) {
      process.on('exit', () => { process.exitCode = 0 })
      t.check('failed', false)
    }`
    })
    try {
      const result = await launch(dir, '1/5').done
      expect(result.code).not.toBe(0)
      expect(result.text).toContain('status disagrees with its report')
      expect(completed(result.output)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('refuses invalid hosts, filters and nonempty report directories before work starts', async () => {
    const dir = fixture({ 'probe.spec.mjs': passing })
    try {
      for (const args of [
        [],
        ['0/5', `--report-dir=${path.join(dir, 'invalid-reports')}`],
        ['6/5', `--report-dir=${path.join(dir, 'invalid-reports')}`],
        ['1/4', `--report-dir=${path.join(dir, 'invalid-reports')}`],
        ['1/5', '--report-dir='],
        ['1/5', '--report-dir=x', 'probe']
      ]) {
        const result = await launch(dir, '1/5', `invalid-${args.length}-${String(args[0])}`, args)
          .done
        expect(result.code).not.toBe(0)
        expect(result.text).toContain('Usage:')
        expect(completed(result.output)).toBe(false)
        expect(existsSync(path.join(dir, 'invalid-reports'))).toBe(false)
      }
      const first = await launch(dir, '1/5', 'stale').done
      expect(first.code, first.text).toBe(0)
      const stale = await launch(dir, '1/5', 'stale').done
      expect(stale.code).not.toBe(0)
      expect(stale.text).toContain('Report directory must be empty')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps simultaneous batches in separate fixture namespaces', async () => {
    const dir = fixture(
      Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`probe-${i}.spec.mjs`, passing]))
    )
    try {
      const batches = await Promise.all(['one', 'two'].map((name) => launch(dir, '1/5', name).done))
      expect(batches.map((b) => b.code)).toEqual([0, 0])
      const namespaces = batches.flatMap((b) =>
        reportsAt(b.reports).map((r) => r.results[r.selected[0]][0].detail)
      )
      expect(new Set(namespaces).size).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('signals every co-resident worker and never attests an interrupted batch', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `probe-${i}.spec.mjs`,
        `import {writeFileSync} from 'node:fs'
      export async function run(t) {
        writeFileSync(new URL('./pid-${i}', import.meta.url), String(process.pid))
        t.check('ready', true)
        await new Promise(() => {})
      }`
      ])
    )
    const dir = fixture(files)
    const batch = launch(dir, '1/5')
    try {
      const limit = Date.now() + 10_000
      while (readdirSync(dir).filter((n) => n.startsWith('pid-')).length < 1 && Date.now() < limit)
        await new Promise((r) => setTimeout(r, 20))
      const pids = readdirSync(dir)
        .filter((n) => n.startsWith('pid-'))
        .map((n) => Number(readFileSync(path.join(dir, n), 'utf8')))
      expect(pids).toHaveLength(1)
      batch.child.kill('SIGTERM')
      const result = await batch.done
      expect(result.code).not.toBe(0)
      expect(completed(result.output)).toBe(false)
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      if (batch.child.exitCode === null) {
        batch.child.kill('SIGTERM')
        await batch.done
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
