#!/usr/bin/env node
// Four hosted jobs each run one global shard on an isolated Mac. Only the aggregate
// can claim the full inventory; this process proves its own workers completed.
import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { availableParallelism, totalmem } from 'node:os'
import { promisify } from 'node:util'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectShard } from './sharding.mjs'
import { mergeReports } from './merge-reports.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const [host, reportOption, ...extra] = process.argv.slice(2)
if (
  !/^[1-4]\/4$/.test(host || '') ||
  !reportOption?.startsWith('--report-dir=') ||
  !reportOption.slice(13) ||
  extra.length
)
  throw new Error('Usage: ci-batch.mjs 1/4|2/4|3/4|4/4 --report-dir=EMPTY_DIRECTORY')
const hostIndex = Number(host[0])
const indices = [hostIndex]
const directory = path.resolve(reportOption.slice(13))
if (existsSync(directory) && readdirSync(directory).length)
  throw new Error(`Report directory must be empty: ${directory}`)
const specs = readdirSync(process.env.CLAVE_E2E_SPECS_DIR || HERE)
  .filter((f) => f.endsWith('.spec.mjs'))
  .sort()
if (!specs.length) throw new Error('No matching specs')
mkdirSync(directory, { recursive: true })
const namespace = `clave-e2e-ci-${randomUUID()}`
const workerEnv = { ...process.env, CLAVE_E2E_NS: namespace }
// Only the coordinator may attest that every worker process completed.
delete workerEnv.GITHUB_OUTPUT
const children = new Set()
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    interrupted = true
    process.exitCode = 1
    for (const child of children) child.kill('SIGTERM')
  })

// These are sampled process-tree RSS sums, including shared pages and the
// short-lived ps probe. They are conservative observations, not a memory gate.
const execute = promisify(execFile)
const resources = {
  host: hostIndex,
  globalShards: 4,
  workers: 1,
  namespace,
  logicalCpus: availableParallelism(),
  totalMemoryBytes: totalmem(),
  samplingIntervalMs: 2000,
  samples: 0,
  maxSampledRssKiB: 0,
  maxSampledLifetimeCpuPercent: 0,
  maxSampledProcesses: 0,
  samplingErrors: [],
  startedAt: new Date().toISOString(),
  completed: false,
  workerOutcomes: []
}
async function sample() {
  try {
    const { stdout } = await execute('ps', ['-A', '-o', 'pid=,ppid=,rss=,%cpu='], {
      timeout: 1500,
      env: { ...process.env, LC_ALL: 'C' }
    })
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
    if (!rows.every((row) => row.length === 4 && row.every(Number.isFinite)))
      throw new Error('Invalid process resource sample')
    const owned = new Set([process.pid])
    let added = true
    while (added) {
      added = false
      for (const [pid, ppid] of rows)
        if (owned.has(ppid) && !owned.has(pid)) {
          owned.add(pid)
          added = true
        }
    }
    const selected = rows.filter(([pid]) => owned.has(pid))
    resources.samples++
    resources.maxSampledRssKiB = Math.max(
      resources.maxSampledRssKiB,
      selected.reduce((sum, row) => sum + row[2], 0)
    )
    resources.maxSampledLifetimeCpuPercent = Math.max(
      resources.maxSampledLifetimeCpuPercent,
      selected.reduce((sum, row) => sum + row[3], 0)
    )
    resources.maxSampledProcesses = Math.max(resources.maxSampledProcesses, selected.length)
  } catch (error) {
    resources.samplingErrors.push(error.message)
  }
}
async function swapUsage() {
  if (process.platform !== 'darwin') return null
  try {
    return (await execute('sysctl', ['-n', 'vm.swapusage'], { timeout: 1500 })).stdout.trim()
  } catch {
    return null
  }
}
resources.swapBefore = await swapUsage()
let sampling = Promise.resolve()
const queueSample = () => {
  sampling = sampling.then(sample)
}
const timer = setInterval(queueSample, resources.samplingIntervalMs)
timer.unref()
const waits = []
let complete = false
console.log(
  `Hosted batch ${host}: shards ${indices.join(',')}/4, maximum 1 worker; reports: ${directory}`
)
try {
  // A cancellation may arrive during the asynchronous startup resource probe.
  if (interrupted) throw new Error('Batch interrupted before worker launch')
  for (const index of indices) {
    const log = openSync(path.join(directory, `shard-${index}.log`), 'w')
    let child
    try {
      child = spawn(
        process.execPath,
        [
          path.join(HERE, 'run.mjs'),
          '--shard',
          `${index}/4`,
          '--report',
          path.join(directory, `shard-${index}.json`)
        ],
        {
          env: workerEnv,
          stdio: ['ignore', log, log]
        }
      )
    } finally {
      closeSync(log)
    }
    children.add(child)
    waits.push(
      new Promise((resolve) => {
        child.once('error', (error) =>
          resolve({ index, code: null, signal: null, error: error.message })
        )
        child.once('close', (code, signal) => {
          children.delete(child)
          resolve({ index, code, signal })
        })
      })
    )
  }
  queueSample()
  resources.workerOutcomes = await Promise.all(waits)
  if (
    interrupted ||
    resources.workerOutcomes.some(({ code, signal }) => signal || ![0, 1].includes(code))
  )
    throw new Error(`A worker did not complete: ${JSON.stringify(resources.workerOutcomes)}`)
  for (const { index, code } of resources.workerOutcomes) {
    const report = JSON.parse(readFileSync(path.join(directory, `shard-${index}.json`), 'utf8'))
    if (report.shard?.index !== index || report.shard.total !== 4 || report.exitCode !== code)
      throw new Error(`Worker ${index} status disagrees with its report`)
    // Validate this fragment against its independently computed global selection.
    // Only the in-memory validation view is 1/1; the artifact stays index/4.
    const expected = selectShard(specs, { index, total: 4 })
    const merged = mergeReports([{ ...report, shard: { index: 1, total: 1 } }], expected, 1)
    console.log(`Shard ${index}/4: ${merged.specs} specs; ${JSON.stringify(merged.totals)}`)
    for (const failed of merged.failedChecks)
      console.log(`  ${failed.kind.toUpperCase()} ${failed.spec}: ${failed.name}`)
  }
  complete = true
  process.exitCode = resources.workerOutcomes.some(({ code }) => code === 1) ? 1 : 0
} finally {
  if (!complete) for (const child of children) child.kill('SIGTERM')
  const settled = await Promise.allSettled(waits)
  if (!resources.workerOutcomes.length)
    resources.workerOutcomes = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
  clearInterval(timer)
  queueSample()
  await sampling
  resources.swapAfter = await swapUsage()
  resources.completed = complete && !interrupted
  resources.completedAt = new Date().toISOString()
  writeFileSync(
    path.join(directory, `resources-host-${hostIndex}.json`),
    JSON.stringify(resources, null, 2) + '\n'
  )
}
if (interrupted) process.exitCode = 1
// The workflow gates this output separately from the report step's exit code.
// Thus an OS failure after a valid report cannot hide behind continue-on-error.
if (complete && !interrupted && process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, 'complete=true\n')
