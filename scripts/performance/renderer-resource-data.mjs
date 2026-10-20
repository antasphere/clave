/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript verification tooling */
import assert from 'node:assert/strict'

export const REQUIRED_TOOLING = Object.freeze([
  'scripts/performance/renderer-resource.mjs',
  'scripts/performance/renderer-resource-data.mjs',
  'scripts/performance/renderer-resource-data.test.mjs',
  'tests/e2e/renderer-resource-workload.mjs',
  'tests/e2e/renderer-resource-fixture.mjs',
  'docs/performance/ui-responsiveness-parser-20261019/renderer-resource-protocol.md',
  'tests/e2e/renderer-workload.mjs',
  'tests/e2e/harness.mjs',
  'tests/e2e/namespace.mjs',
  'tests/e2e/bounds.mjs',
  'scripts/server-process.mjs'
])

export function validateToolingInventory(files) {
  for (const name of REQUIRED_TOOLING)
    assert.match(
      files?.[name] || '',
      /^[a-f0-9]{64}$/,
      'missing transitive frozen tooling: ' + name
    )
}

export const RESOURCE_CONFIG = Object.freeze({
  tabs: 100,
  groups: 10,
  longHistories: 20,
  turns: 200,
  shortTurns: 2,
  slot: 99,
  responseBytes: 34380,
  chunkBytes: 128,
  intervalMs: 50,
  warmChunks: 500,
  cycleChunks: 20,
  cycles: 5,
  closures: 6,
  settleMs: 1000,
  gcPasses: 2,
  launches: 3,
  ratioMax: 1.2,
  bootMs: 60000,
  fixtureMs: 120000,
  locatorMs: 15000,
  mcpMs: 10000,
  producerMs: 60000,
  cdpMs: 10000,
  launchMs: 600000
})
export const MILESTONES = Object.freeze([
  'warm',
  ...Array.from({ length: 5 }, (_, i) => [`cycle-${i + 1}-warm`, `cycle-${i + 1}-closed`]).flat(),
  'final-closed'
])
export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const equal = (a, b, message) => assert.deepEqual(a, b, message)
const positive = (n) => Number.isFinite(n) && n > 0

// One controller owns all temporary measurement work. Entries disappear only
// after affirmative disposal. Failing a deadline fences every late result.
export class ResourceController {
  pending = new Map()
  stopped = false
  failure = null
  samples = []
  constructor(persist) {
    this.persist = persist
  }
  own(kind, id) {
    assert.ok(!this.stopped && !this.pending.has(id), 'duplicate/stopped owned work')
    this.pending.set(id, kind)
  }
  disposed(id, acknowledged) {
    assert.equal(acknowledged, true, 'uncertain disposal')
    assert.ok(this.pending.delete(id), 'unknown disposed work')
  }
  quiescence() {
    assert.ok(!this.stopped, 'collection fenced')
    equal([...this.pending], [], 'pending producer/waiter/callback/handle blocks GC')
    return { acknowledged: true, pending: [], at: Date.now() }
  }
  fail(error) {
    if (!this.stopped) {
      this.stopped = true
      this.failure = { message: String(error.message || error), at: Date.now() }
      this.persist({ failure: this.failure, later: 'NOTRUN' })
    }
  }
  async bounded(label, run, ms) {
    assert.ok(!this.stopped, 'collection fenced')
    let timer
    try {
      const value = await Promise.race([
        Promise.resolve().then(run),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' timeout')), ms)
        })
      ])
      assert.ok(!this.stopped, 'late result fenced')
      return value
    } catch (error) {
      this.fail(error)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  firstDom(actual, assertContent) {
    assert.ok(!this.stopped, 'collection fenced')
    this.persist({ firstDom: actual })
    try {
      assertContent(actual)
    } catch (error) {
      this.fail(error)
      throw error
    }
  }
  accept(sample) {
    this.quiescence()
    assert.equal(sample.label, MILESTONES[this.samples.length], 'ordered sample')
    this.persist({ sample })
    this.samples.push(sample)
  }
}

export function validateLaunch(run, frozen, side, index, rawIds = new Set()) {
  assert.equal(run.status, 'COMPLETE', 'incomplete launch')
  assert.equal(run.side, side)
  assert.equal(run.index, index)
  equal(run.config, RESOURCE_CONFIG, 'fixed population/config')
  equal(run.binding, frozen[side].binding, 'source/build/lock/tool/workload binding')
  assert.ok(run.startedAt >= frozen.createdAt && run.endedAt >= run.startedAt, 'fresh launch')
  assert.ok(run.endedAt - run.startedAt <= RESOURCE_CONFIG.launchMs, 'launch ceiling')
  assert.match(run.runId, /^[0-9a-f-]{36}$/)
  assert.equal(run.scenario?.name, 'chat/renderer-resource')
  equal(run.scenario.completed, ['chat/renderer-resource'], 'actual fixture completed keys')
  assert.equal(run.scenario.runId, run.runId)
  assert.equal(run.target?.hidden, true)
  assert.equal(run.target?.backgroundThrottling, false)
  assert.ok(positive(run.target?.pid) && run.target?.id, 'same owned renderer target')
  equal(run.errors, [], 'renderer errors')
  assert.equal(run.closures, 6)
  assert.equal(new Set(run.originalLongIds).size, 20)
  assert.equal(run.observations.length, 12, 'dense twelve values')
  let previous = run.startedAt
  for (let i = 0; i < MILESTONES.length; i++) {
    const s = run.observations[i]
    assert.equal(s.label, MILESTONES[i], 'ordered milestone')
    equal(s.target, run.target, 'target changed')
    assert.equal(s.origin, 'Runtime.getHeapUsage')
    assert.equal(s.synthetic, false)
    assert.match(s.rawId, /^[0-9a-f-]{36}$/)
    assert.ok(!rawIds.has(s.rawId), 'reused/stale observation identity')
    rawIds.add(s.rawId)
    assert.ok(s.at > previous && s.at <= run.endedAt, 'stale observation time')
    previous = s.at
    assert.ok(
      positive(s.usage?.usedSize) && s.usage.totalSize >= s.usage.usedSize,
      'actual finite usedSize/totalSize'
    )
    for (const k of ['embedderHeapUsedSize', 'backingStorageSize'])
      if (k in s.usage)
        assert.ok(Number.isFinite(s.usage[k]) && s.usage[k] >= 0, 'optional usage metric')
    equal(s.disposal?.pending, [], 'all owned measurement work disposed')
    assert.equal(s.disposal.acknowledged, true)
    assert.ok(s.disposal.at <= s.settle.startedAt)
    assert.equal(s.settle.beforeFrames, 2)
    assert.equal(s.settle.afterFrames, 2)
    assert.equal(s.settle.configuredMs, 1000)
    assert.ok(s.settle.elapsedMs >= 1000 && s.settle.endedAt >= s.settle.startedAt + 1000)
    equal(
      s.commands.map((c) => c.method),
      [
        'Runtime.releaseObjectGroup',
        'HeapProfiler.collectGarbage',
        'HeapProfiler.collectGarbage',
        'Runtime.getHeapUsage'
      ],
      'strict measurement method sequence'
    )
    let commandTime = s.settle.endedAt
    for (const c of s.commands) {
      assert.equal(c.acknowledged, true)
      assert.ok(
        c.startedAt >= commandTime && c.endedAt >= c.startedAt && c.endedAt - c.startedAt <= 10000
      )
      commandTime = c.endedAt
    }
    equal(s.commands[3].result, s.usage, 'raw response must be actual usedSize source')
    assert.equal(s.detached, true)
    assert.ok(s.at >= commandTime)
    equal(s.population.longIds, run.originalLongIds, 'original histories retained')
    assert.equal(new Set(s.population.liveIds).size, 100)
    assert.ok(s.population.longIds.every((id) => s.population.liveIds.includes(id)))
    assert.equal(s.population.groups, 10)
    assert.equal(s.population.longTurns, 200)
    assert.equal(s.population.slotTurns, s.label.endsWith('closed') ? 2 : null)
    assert.equal(s.population.finalReplacementWarmed, false)
    if (s.label === 'warm' || s.label.endsWith('-warm')) {
      assert.equal(s.content.complete, true)
      equal(s.content.views, ['chat', 'terminal', 'chat'])
      assert.equal(s.content.chunks, i === 0 ? 500 : 20)
      assert.equal(s.content.firstSamples, 3)
      assert.equal(s.content.sampleCount, 1)
      assert.equal(s.content.working, true)
      assert.equal(s.content.producerStopped, true)
    }
  }
  assert.equal(run.cleanup.complete, true)
  assert.equal(run.cleanup.forced, false)
  assert.equal(run.cleanup.timedOut, false)
  equal(run.cleanup.unknown, [])
  assert.equal(run.cleanup.profileRemoved, true)
  assert.ok(run.cleanup.processes.length >= 4, 'main/renderer/server/terminal-process identities')
  for (const role of ['main', 'renderer', 'server', 'terminal-process'])
    assert.ok(run.cleanup.processes.some((p) => p.role === role))
  for (const p of run.cleanup.processes)
    assert.ok(positive(p.pid) && p.creation && p.exited === true, 'positive owned PID exit')
  return run
}

export function compareResources(runs, frozen) {
  assert.equal(frozen.schema, 1)
  assert.ok(
    frozen.control.rawCurrentDev === true &&
      frozen.control.binding.product !== frozen.candidate.binding.product,
    'raw current dev and nonidentical whole feature'
  )
  for (const k of ['lock', 'tooling', 'workload', 'runtime', 'settings'])
    assert.ok(
      frozen.control.binding[k] && frozen.control.binding[k] === frozen.candidate.binding[k],
      'matched ' + k
    )
  equal(
    runs.map((r) => r.side),
    ['control', 'control', 'control', 'candidate', 'candidate', 'candidate'],
    'serialized control three then candidate three'
  )
  const ids = new Set()
  for (let i = 0; i < 6; i++) {
    validateLaunch(runs[i], frozen, i < 3 ? 'control' : 'candidate', (i % 3) + 1, ids)
    if (i) assert.ok(runs[i].startedAt >= runs[i - 1].endedAt, 'no concurrent cohorts')
  }
  const stats = MILESTONES.map((label, i) => {
    const control = runs.slice(0, 3).map((r) => r.observations[i].usage.usedSize)
    const candidate = runs.slice(3).map((r) => r.observations[i].usage.usedSize)
    return {
      label,
      control,
      candidate,
      controlMedian: median(control),
      candidateMedian: median(candidate),
      controlRange: [Math.min(...control), Math.max(...control)],
      candidateRange: [Math.min(...candidate), Math.max(...candidate)],
      ratio: median(candidate) / median(control),
      correspondingRatios: candidate.map((n, j) => n / control[j])
    }
  })
  const ratio = stats[0].ratio
  assert.ok(ratio <= 1.2, 'initial warm median usedSize exceeds 1.20')
  return {
    verdict: 'PRIMARY_RATIO_PASS_REVIEW_TRAJECTORIES',
    ratio,
    stats,
    values: runs.flatMap((r) => r.observations.map((s) => s.usage.usedSize)),
    trajectories: runs.map((r) => ({
      side: r.side,
      index: r.index,
      warm: r.observations
        .filter((s) => s.label === 'warm' || s.label.endsWith('-warm'))
        .map((s) => s.usage.usedSize),
      closed: r.observations.filter((s) => s.label.endsWith('closed')).map((s) => s.usage.usedSize)
    })),
    limits:
      'Target renderer V8 only. Growth requires review; no exhaustive-holder or no-leak claim.'
  }
}
