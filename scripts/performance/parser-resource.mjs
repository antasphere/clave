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
import {
  RESOURCE_CONFIG,
  decodeHeap,
  inspectPrefixGraph,
  bindCapturedGraph,
  captureQualificationPair,
  captureHeapCheckpoint
} from './parser-resource-data.mjs'
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
    dynamicFixtureSha256: {
      'tests/e2e/renderer-responsiveness-fixture.mjs': sha(
        readFileSync(path.join(REPO, 'tests/e2e/renderer-responsiveness-fixture.mjs'))
      )
    },
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
const rawFiles = new Map()
async function observation(milestone) {
  await frames(win)
  await new Promise((resolve) => setTimeout(resolve, RESOURCE_CONFIG.settleMs))
  await frames(win)
  // Diagnostic was detached in warmResourceProbe. Application identity reads
  // begin only after this session has persisted both usage and the full raw file.
  cdp = await win.context().newCDPSession(win)
  let fd, onChunk
  try {
    const filename = path.join(privateDir, `${milestone}.heapsnapshot`)
    return await captureHeapCheckpoint(cdp, {
      persistUsage(usage) {
        const entry = { milestone, ...usage }
        record.observations.push(entry)
        save()
        return entry
      },
      beginSnapshot() {
        fd = openSync(filename, 'wx', 0o600)
        onChunk = ({ chunk }) => writeSync(fd, chunk)
        cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
      },
      finishSnapshot(entry) {
        cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
        onChunk = null
        closeSync(fd)
        fd = undefined
        assert.equal(statSync(filename).mode & 0o777, 0o600, 'private raw heap mode')
        entry.rawSha256 = sha(readFileSync(filename))
        entry.rawBytes = statSync(filename).size
        save()
        rawFiles.set(milestone, filename)
      }
    })
  } finally {
    if (onChunk) cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
    if (fd !== undefined) closeSync(fd)
    // Retain only this session until bounded post-snapshot binding. No handles yet.
  }
}
function analyzeEntry(entry, bindingPlanOnly = false) {
  const raw = JSON.parse(readFileSync(rawFiles.get(entry.milestone), 'utf8'))
  if (values.cohort === 'candidate')
    return inspectPrefixGraph(raw, { discoveryOnly: true, bindingPlanOnly })
  const graph = decodeHeap(raw)
  return {
    qualified: false,
    reason: 'Original-full graph qualification pending',
    nodes: graph.nodes.length,
    strongNodes: graph.parent.size
  }
}
async function binding(entry, expectedInputs) {
  let result, operationError, detachError
  try {
    const graph = analyzeEntry(entry, true)
    result =
      values.cohort === 'candidate'
        ? await bindCapturedGraph(cdp, graph, expectedInputs)
        : { qualified: false, reason: 'Original-full binding adapter pending' }
  } catch (e) {
    operationError = e
  } finally {
    try {
      await cdp.detach()
      cdp = null
    } catch (e) {
      detachError = e
    }
    save()
  }
  if (detachError)
    throw new AggregateError(
      [operationError, detachError].filter(Boolean),
      'binding session detach failed; stop before lifecycle/GC'
    )
  if (operationError) throw operationError
  return result
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
    throttled: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling(),
    mainPid: process.pid,
    rendererPid: BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      v8: process.versions.v8
    },
    ownedProcesses: app.getAppMetrics().map(({ pid, type }) => ({ pid, type }))
  }))
  assert.equal(record.identity.userData, dir)
  delete record.identity.userData
  for (const key of ['mainPid', 'rendererPid'])
    assert.ok(
      Number.isSafeInteger(record.identity[key]) && record.identity[key] > 0,
      'owned ' + key
    )
  for (const key of ['electron', 'chrome', 'v8'])
    assert.ok(
      typeof record.identity.versions[key] === 'string' && record.identity.versions[key].length > 0,
      'actual ' + key + ' version'
    )
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
  delete diagnostic.priorInputs
  record.diagnostic = diagnostic
  save()
  const pair = await captureQualificationPair({
    capture: observation,
    bind: (entry) => binding(entry, [expected, ...probe.priorInputs]),
    close: async () => {
      assert.equal(cdp, null, 'binding session detached before lifecycle')
      assert.deepEqual(record.pageErrors, [], 'semantic errors stop lifecycle')
      await replaceResourceSlot({ app, win, fixture, root, workload, id, cycle: 1 })
    },
    analyze: (entry) => {
      const graph = analyzeEntry(entry)
      if (
        entry.milestone === 'final-closed' &&
        values.cohort === 'candidate' &&
        graph.allPrefixes.length
      )
        graph.blocker = 'post-close live prefix requires owner/retaining-path review'
      return graph
    }
  })
  record.representationFailures = pair.failures
  record.completedRawPair = pair.completedRawPair
  save()
  assert.deepEqual(record.pageErrors, [])
  record.ok = pair.failures.length === 0
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
