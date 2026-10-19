#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript resource tooling */
// Not a formal latency collector. First actual-graph qualification is a separate approval gate.
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
  rmSync,
  chmodSync,
  statSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { launchApp, seedWorkspaces, REPO } from '../../tests/e2e/harness.mjs'
import {
  loadWorkloadScenario,
  seedRendererWorkload,
  frames
} from '../../tests/e2e/renderer-workload.mjs'
import {
  warmResourceProbe,
  replaceResourceSlot
} from '../../tests/e2e/parser-resource-workload.mjs'
import { RESOURCE_CONFIG, decodeHeap, inspectPrefixGraph } from './parser-resource-data.mjs'
const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    private: { type: 'string' },
    cohort: { type: 'string' },
    purpose: { type: 'string', default: 'collection' }
  }
})
assert.ok(['r2', 'candidate'].includes(values.cohort), 'explicit resource cohort')
assert.ok(['qualification', 'collection'].includes(values.purpose), 'unknown resource purpose')
// No override flag or fabricated qualification receipt. A reviewed actual graph
// adapter and source-bound protocol amendment are needed before six resource launches.
assert.equal(
  values.purpose,
  'qualification',
  'BLOCKED: actual V8/React graph qualification must precede resource collection'
)
assert.ok(values.out && values.private, 'fresh public summary and private raw directories required')
const out = path.resolve(values.out),
  privateDir = path.resolve(values.private)
assert.ok(
  !privateDir.startsWith(REPO + path.sep) && privateDir !== REPO,
  'raw heaps must stay outside repository'
)
assert.ok(
  out !== privateDir &&
    !out.startsWith(privateDir + path.sep) &&
    !privateDir.startsWith(out + path.sep),
  'separate private heap path'
)
mkdirSync(out, { recursive: false })
mkdirSync(privateDir, { recursive: false, mode: 0o700 })
chmodSync(privateDir, 0o700)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const files = new Set()
function visit(name) {
  if (files.has(name)) return
  files.add(name)
  for (const m of readFileSync(path.join(REPO, name), 'utf8').matchAll(
    /(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g
  )) {
    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(name), m[1]))
    assert.ok(!dependency.startsWith('../'))
    visit(dependency)
  }
}
visit('scripts/performance/parser-resource.mjs')
for (const pkg of [
  'electron',
  'playwright-core',
  'esbuild',
  'react',
  'react-dom',
  'react-markdown',
  'remark-gfm'
])
  files.add(`node_modules/${pkg}/package.json`)
function buildHashes(dir = 'out') {
  return Object.fromEntries(
    readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((e) => {
      const name = path.posix.join(dir, e.name)
      return e.isDirectory()
        ? Object.entries(buildHashes(name))
        : [[name, sha(readFileSync(path.join(REPO, name)))]]
    })
  )
}
const result = {
  schema: 1,
  purpose: values.purpose,
  cohort: values.cohort,
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
  config: RESOURCE_CONFIG,
  qualified: false,
  status: { exitCode: 1, complete: false },
  provenance: {
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: REPO, encoding: 'utf8' }).trim(),
    status: execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }),
    trackedOverlaySha256: sha(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: REPO })),
    buildSha256: buildHashes(),
    transitiveSha256: Object.fromEntries(
      [...files].sort().map((n) => [n, sha(readFileSync(path.join(REPO, n)))])
    ),
    packageLockSha256: sha(readFileSync(path.join(REPO, 'package-lock.json')))
  },
  machine: {
    cpu: os.cpus()[0].model,
    cpus: os.cpus().length,
    arch: os.arch(),
    release: os.release(),
    node: process.version
  },
  runs: []
}
const save = () =>
  writeFileSync(
    path.join(out, 'resource-qualification.json'),
    JSON.stringify(result, null, 2) + '\n'
  )
const dir = mkdtempSync(path.join(os.tmpdir(), 'clave-parser-resource-')),
  root = path.join(dir, 'workspace')
mkdirSync(root)
seedWorkspaces(dir, {
  workspaces: [
    { id: 'synthetic', name: 'Synthetic', rootDir: root, profileFile: null, createdAt: 1 }
  ],
  activeWorkspaceId: 'synthetic'
})
let app, win, fixture, cdp
const record = {
  run: 1,
  pageErrors: [],
  observations: [],
  load: os.loadavg(),
  ok: false,
  graphQualified: false
}
result.runs.push(record)
async function observation(milestone, { expected, warm } = {}) {
  await frames(win)
  await new Promise((resolve) => setTimeout(resolve, RESOURCE_CONFIG.settleMs))
  await frames(win)
  // Diagnostic was detached in warmResourceProbe. All evaluations returned by value;
  // no application object is obtained via Runtime remote object handles.
  cdp = await win.context().newCDPSession(win)
  let fd, onChunk
  try {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'parser-resource' })
    for (let i = 0; i < RESOURCE_CONFIG.gcPasses; i++) await cdp.send('HeapProfiler.collectGarbage')
    const usage = await cdp.send('Runtime.getHeapUsage')
    assert.ok(
      Number.isFinite(usage.usedSize) && usage.usedSize > 0 && usage.totalSize >= usage.usedSize,
      'actual GC heap metric'
    )
    const entry = { milestone, ...usage }
    record.observations.push(entry)
    save()
    const filename = path.join(privateDir, `${milestone}.heapsnapshot`)
    fd = openSync(filename, 'wx', 0o600)
    onChunk = ({ chunk }) => writeSync(fd, chunk)
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
    await cdp.send('HeapProfiler.takeHeapSnapshot', {
      reportProgress: false,
      captureNumericValue: true,
      exposeInternals: true
    })
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
    onChunk = null
    closeSync(fd)
    fd = undefined
    assert.equal(statSync(filename).mode & 0o777, 0o600, 'private raw heap mode')
    entry.rawSha256 = sha(readFileSync(filename))
    entry.rawBytes = statSync(filename).size
    save()
    const raw = JSON.parse(readFileSync(filename, 'utf8'))
    // Unknown/incomplete graph failure preserves both the numeric observation and raw file.
    if (values.cohort === 'candidate')
      entry.graph = inspectPrefixGraph(raw, {
        expectedInput: expected,
        closed: milestone === 'final-closed',
        warm
      })
    else {
      const graph = decodeHeap(raw)
      entry.graph = {
        qualified: false,
        reason: 'Original-full graph qualification pending',
        nodes: graph.nodes.length,
        strongNodes: graph.parent.size
      }
    }
    save()
    return entry.graph
  } finally {
    if (onChunk) cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
    if (fd !== undefined) closeSync(fd)
    await cdp.detach()
    cdp = null
  }
}
try {
  ;({ app, win, fixture } = await launchApp(dir, {
    server: 'separate',
    env: { SHELL: '/bin/zsh' },
    args: ['--dev-echo-adapter', '--test-no-machine-usage']
  }))
  win.on('pageerror', (e) => record.pageErrors.push(e.message))
  win.setDefaultTimeout(15000)
  record.identity = await app.evaluate(({ app, BrowserWindow }) => ({
    userData: app.getPath('userData'),
    visible: BrowserWindow.getAllWindows()[0].isVisible(),
    throttled: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling()
  }))
  assert.equal(record.identity.userData, dir)
  delete record.identity.userData
  assert.equal(record.identity.visible, false)
  assert.equal(record.identity.throttled, false)
  record.server = JSON.parse(readFileSync(path.join(dir, 'clave-server.json'), 'utf8')).mode
  assert.equal(record.server, 'separate')
  const receipt = await loadWorkloadScenario(
    () => seedRendererWorkload(app, win, fixture, root),
    path.join(dir, 'scenario.mjs')
  )
  const workload = receipt.values.workload
  record.fixture = { scenario: 'chat/renderer-responsiveness', runId: receipt.runId }
  const id = workload.records[99]
  const probe = await warmResourceProbe({
    win,
    fixture,
    id,
    chunks: 500,
    candidate: values.cohort === 'candidate'
  })
  const { expected, ...diagnostic } = probe
  record.diagnostic = diagnostic
  save()
  const warm = await observation('warm', { expected })
  await replaceResourceSlot({ app, win, fixture, root, workload, id, cycle: 1 })
  await observation('final-closed', { warm })
  assert.deepEqual(record.pageErrors, [])
  record.ok = true
  result.completedAt = new Date().toISOString()
  // A qualification probe produces evidence, never a resource PASS. Root must
  // review actual shapes/closures/React alternates and approve the next adapter.
  result.blocker =
    'HOLD: actual graph and closed retaining paths need root review; no resource comparison authorized'
} catch (error) {
  record.error = String(error).replaceAll(REPO, '[repo]').replaceAll(dir, '[data]')
  throw error
} finally {
  try {
    await fixture?.evaluate(() => {
      globalThis.__parserResourceProducer?.stop()
      delete globalThis.__parserResourceProducer
    })
  } catch {
    /* instance may already have stopped */
  }
  try {
    await cdp?.detach()
  } finally {
    try {
      if (app) {
        await app.close()
        record.closed = true
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
      record.cleaned = true
      save()
    }
  }
}
console.error(result.blocker)
process.exitCode = 1
