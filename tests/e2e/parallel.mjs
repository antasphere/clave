#!/usr/bin/env node
// Separate Node processes keep spec globals, Electron pids and cleanup independent.
import { spawn } from 'node:child_process'
import { availableParallelism, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRunArgs } from './sharding.mjs'
import { mergeReports } from './merge-reports.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const workersArg = args.find((a) => a.startsWith('--workers='))
const reportArg = args.find((a) => a.startsWith('--report-dir='))
if (args.filter((a) => a.startsWith('--workers=')).length > 1)
  throw new Error('Duplicate --workers')
if (args.filter((a) => a.startsWith('--report-dir=')).length > 1)
  throw new Error('Duplicate --report-dir')
const workers = workersArg ? Number(workersArg.split('=')[1]) : Math.min(4, availableParallelism())
if (!Number.isInteger(workers) || workers < 1 || workers > 32)
  throw new Error('--workers must be an integer between 1 and 32')
const filters = args.filter((a) => a !== workersArg && a !== reportArg)
const options = parseRunArgs(filters)
if (options.report || options.list || options.shard.total !== 1)
  throw new Error('parallel.mjs accepts spec filters and --workers=N only')
const specsDir = process.env.CLAVE_E2E_SPECS_DIR || HERE
const specs = readdirSync(specsDir)
  .filter((f) => f.endsWith('.spec.mjs'))
  .filter((f) => !options.filters.length || options.filters.some((o) => f.includes(o)))
  .sort()
if (!specs.length) throw new Error('No matching specs')
if (reportArg === '--report-dir=') throw new Error('--report-dir needs a path')
const namespace = `clave-e2e-parallel-${randomUUID()}`
const directory = reportArg
  ? path.resolve(reportArg.slice('--report-dir='.length))
  : mkdtempSync(path.join(tmpdir(), 'clave-e2e-parallel-'))
if (existsSync(directory) && readdirSync(directory).length)
  throw new Error(`Report directory must be empty: ${directory}`)
mkdirSync(directory, { recursive: true })
const children = new Set()
const started = Date.now()
console.log(`Running ${specs.length} specs with ${workers} workers; logs and reports: ${directory}`)
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    interrupted = true
    for (const child of children) child.kill('SIGTERM')
  })
const outcomes = await Promise.all(
  Array.from({ length: workers }, async (_, i) => {
    const index = i + 1
    const report = path.join(directory, `shard-${index}.json`)
    const log = openSync(path.join(directory, `shard-${index}.log`), 'w')
    const child = spawn(
      process.execPath,
      [
        path.join(HERE, 'run.mjs'),
        ...filters,
        '--shard',
        `${index}/${workers}`,
        '--report',
        report
      ],
      {
        env: { ...process.env, CLAVE_E2E_NS: namespace },
        stdio: ['ignore', log, log]
      }
    )
    closeSync(log)
    children.add(child)
    const code = await new Promise((resolve) => {
      child.once('error', () => resolve(null))
      child.once('close', (status) => resolve(status))
    })
    children.delete(child)
    console.log(`Shard ${index}/${workers} exited ${code}; ${Date.now() - started} ms elapsed`)
    return { code, report }
  })
)
if (interrupted || outcomes.some(({ code }) => ![0, 1].includes(code)))
  throw new Error(`A worker did not complete; inspect ${directory}`)
const reports = outcomes.map(({ report }) => JSON.parse(readFileSync(report, 'utf8')))
// mergeReports also proves every spec and assertion result exists exactly once.
const merged = mergeReports(reports, specs, workers)
console.log(
  `${merged.specs} specs; ${JSON.stringify(merged.totals)}; wall time ${Date.now() - started} ms`
)
for (const failed of merged.failedChecks)
  console.log(`  ${failed.kind.toUpperCase()} ${failed.spec}: ${failed.name}`)
if (!reportArg && merged.exitCode === 0) rmSync(directory, { recursive: true, force: true })
process.exit(merged.exitCode)
