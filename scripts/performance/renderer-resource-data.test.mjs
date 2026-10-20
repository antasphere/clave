/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript verification tooling */
import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  RESOURCE_CONFIG,
  MILESTONES,
  ResourceController,
  compareResources,
  REQUIRED_TOOLING,
  validateToolingInventory
} from './renderer-resource-data.mjs'
import { resourceLiteral } from '../../tests/e2e/renderer-resource-workload.mjs'

function fixture(ratio = 1.2) {
  const shared = {
    lock: 'same lock',
    tooling: 'same frozen tools',
    workload: 'same workload',
    runtime: 'same Electron',
    settings: 'same isolated settings'
  }
  const frozen = {
    schema: 1,
    createdAt: 1000,
    control: {
      rawCurrentDev: true,
      binding: { ...shared, product: 'raw current dev', source: 'raw source', build: 'raw build' }
    },
    candidate: {
      binding: {
        ...shared,
        product: 'whole feature',
        source: 'candidate source',
        build: 'candidate build'
      }
    }
  }
  const runs = Array.from({ length: 6 }, (_, i) => {
    const side = i < 3 ? 'control' : 'candidate',
      startedAt = 1000 + i * 100000
    const target = {
      id: 'owned-target-' + i,
      pid: i + 100,
      hidden: true,
      backgroundThrottling: false
    }
    const originalLongIds = Array.from({ length: 20 }, (_, n) => 'long-' + n)
    const observations = MILESTONES.map((label, n) => {
      const at = startedAt + n * 2000,
        usage = { usedSize: i < 3 ? 100 : ratio * 100, totalSize: 1000 }
      return {
        label,
        target,
        origin: 'Runtime.getHeapUsage',
        synthetic: false,
        rawId: randomUUID(),
        at: at + 1500,
        usage,
        disposal: { pending: [], acknowledged: true, at },
        settle: {
          startedAt: at + 1,
          endedAt: at + 1001,
          configuredMs: 1000,
          elapsedMs: 1000,
          beforeFrames: 2,
          afterFrames: 2
        },
        commands: [
          'Runtime.releaseObjectGroup',
          'HeapProfiler.collectGarbage',
          'HeapProfiler.collectGarbage',
          'Runtime.getHeapUsage'
        ].map((method, j) => ({
          method,
          acknowledged: true,
          startedAt: at + 1002 + j * 2,
          endedAt: at + 1003 + j * 2,
          result: j === 3 ? usage : {}
        })),
        detached: true,
        population: {
          liveIds: [...originalLongIds, ...Array.from({ length: 80 }, (_, x) => 'short-' + x)],
          longIds: originalLongIds,
          groups: 10,
          longTurns: 200,
          slotTurns: label.endsWith('closed') ? 2 : null,
          finalReplacementWarmed: false
        },
        content: {
          complete: true,
          views: ['chat', 'terminal', 'chat'],
          chunks: n === 0 ? 500 : 20,
          firstSamples: 3,
          sampleCount: 1,
          working: true,
          producerStopped: true
        }
      }
    })
    return {
      side,
      index: (i % 3) + 1,
      status: 'COMPLETE',
      binding: frozen[side].binding,
      config: RESOURCE_CONFIG,
      startedAt,
      endedAt: startedAt + 30000,
      runId: randomUUID(),
      scenario: { name: 'chat/renderer-resource', completed: ['chat/renderer-resource'] },
      target,
      originalLongIds,
      observations,
      errors: [],
      closures: 6,
      cleanup: {
        complete: true,
        forced: false,
        timedOut: false,
        unknown: [],
        profileRemoved: true,
        processes: ['main', 'renderer', 'server', 'terminal-process'].map((role, j) => ({
          pid: j + 1,
          role,
          creation: 'known creation identity',
          exited: true
        }))
      }
    }
  })
  for (const run of runs) run.scenario.runId = run.runId
  return { runs, frozen }
}

describe('whole-feature resource protocol, pure checker qualification only', () => {
  it('requires the collector itself and every declared tool/seed/harness dependency in the frozen overlay', () => {
    const complete = Object.fromEntries(REQUIRED_TOOLING.map((p) => [p, 'a'.repeat(64)]))
    expect(() => validateToolingInventory(complete)).not.toThrow()
    for (const name of REQUIRED_TOOLING) {
      const missing = { ...complete }
      delete missing[name]
      expect(() => validateToolingInventory(missing)).toThrow(name)
    }
    expect(() => validateToolingInventory({})).toThrow('missing transitive')
  })
  it('accepts the exact 1.20 initial-warm boundary and preserves all 72 values/trajectories', () => {
    const { runs, frozen } = fixture()
    const result = compareResources(runs, frozen)
    expect(result.ratio).toBe(1.2)
    expect(result.values).toHaveLength(72)
    expect(result.stats).toHaveLength(12)
    expect(result.trajectories[0].warm).toHaveLength(6)
    expect(result.trajectories[0].closed).toHaveLength(6)
  })
  it('rejects 1.200001 and does not pool small later cycles into the primary', () => {
    const { runs, frozen } = fixture(1.200001)
    for (const run of runs.slice(3))
      for (const s of run.observations.slice(1))
        s.commands[3].result = s.usage = { usedSize: 1, totalSize: 1000 }
    expect(() => compareResources(runs, frozen)).toThrow('1.20')
  })
  it.each([
    ['missing launch', ({ runs }) => runs.pop()],
    ['wrong serialized order', ({ runs }) => runs.reverse()],
    ['missing sample', ({ runs }) => runs[0].observations.pop()],
    ['reordered sample', ({ runs }) => runs[0].observations.reverse()],
    [
      'duplicate raw id',
      ({ runs }) => {
        runs[0].observations[1].rawId = runs[0].observations[0].rawId
      }
    ],
    [
      'nonfinite usage',
      ({ runs }) => {
        runs[0].observations[0].usage.usedSize = NaN
      }
    ],
    [
      'synthetic',
      ({ runs }) => {
        runs[0].observations[0].synthetic = true
      }
    ],
    [
      'forged raw response',
      ({ runs }) => {
        runs[0].observations[0].commands[3].result = { usedSize: 1, totalSize: 1 }
      }
    ],
    [
      'stale timestamp',
      ({ runs }) => {
        runs[0].observations[0].at = 999
      }
    ],
    [
      'wrong build',
      ({ runs }) => {
        runs[0].binding = { build: 'wrong' }
      }
    ],
    [
      'identical product',
      ({ frozen }) => {
        frozen.candidate.binding.product = frozen.control.binding.product
      }
    ],
    [
      'missing actual GC',
      ({ runs }) => {
        runs[0].observations[0].commands.splice(1, 1)
      }
    ],
    [
      'GC before disposal/settle',
      ({ runs }) => {
        runs[0].observations[0].commands[1].startedAt = 1
      }
    ],
    [
      'uncertain disposal',
      ({ runs }) => {
        runs[0].observations[0].disposal.acknowledged = false
      }
    ],
    [
      'pending handle',
      ({ runs }) => {
        runs[0].observations[0].disposal.pending = ['handle']
      }
    ],
    [
      'short settle',
      ({ runs }) => {
        runs[0].observations[0].settle.elapsedMs = 999
      }
    ],
    [
      'target changed',
      ({ runs }) => {
        runs[0].observations[0].target = { id: 'another' }
      }
    ],
    [
      'wrong population',
      ({ runs }) => {
        runs[0].observations[0].population.liveIds.pop()
      }
    ],
    [
      'lost original histories',
      ({ runs }) => {
        runs[0].observations[0].population.longIds = []
      }
    ],
    [
      'final replacement warmed',
      ({ runs }) => {
        runs[0].observations[11].population.finalReplacementWarmed = true
      }
    ],
    [
      'seven closures',
      ({ runs }) => {
        runs[0].closures = 7
      }
    ],
    [
      'missing content',
      ({ runs }) => {
        runs[0].observations[0].content.complete = false
      }
    ],
    [
      'omitted child exit',
      ({ runs }) => {
        runs[0].cleanup.processes.pop()
      }
    ],
    [
      'live owned PID',
      ({ runs }) => {
        runs[0].cleanup.processes[0].exited = false
      }
    ],
    [
      'forced teardown',
      ({ runs }) => {
        runs[0].cleanup.forced = true
      }
    ],
    [
      'cleanup timeout',
      ({ runs }) => {
        runs[0].cleanup.timedOut = true
      }
    ]
  ])('rejects %s', (_name, mutate) => {
    const f = structuredClone(fixture())
    mutate(f)
    expect(() => compareResources(f.runs, f.frozen)).toThrow()
  })

  it('declares exact independent shallow literals, byte counts, numbered chunks and six warm stages', () => {
    for (let cycle = 0; cycle <= 5; cycle++) {
      const value = resourceLiteral(cycle)
      expect(value.chunks).toHaveLength(cycle ? 20 : 500)
      expect(value.chunks.every((chunk) => Buffer.byteLength(chunk) === 128)).toBe(true)
      expect(value.html.match(/<h2>Synthetic response<\/h2>/g)).toHaveLength(12)
      expect(value.html.match(/href="https:\/\/example.com"/g)).toHaveLength(480)
      expect(value.input.startsWith('## Synthetic response')).toBe(true)
      expect(value.html).toContain(value.chunks.at(-1).slice(0, -1))
      if (cycle) expect(value.html).toContain(`<p>Resource cycle ${cycle}</p>`)
    }
  })
  it.each(['producer', 'passive-waiter', 'pending-callback', 'object-handle'])(
    'blocks GC with an active %s',
    (kind) => {
      const c = new ResourceController(() => {})
      c.own(kind, 'owned')
      expect(() => c.quiescence()).toThrow('blocks GC')
      expect(() => c.disposed('owned', false)).toThrow('uncertain')
      c.disposed('owned', true)
      expect(c.quiescence().pending).toEqual([])
      expect(() => c.disposed('unknown', true)).toThrow('unknown')
    }
  )
  it('persists a first DOM mismatch once and refuses retry', () => {
    const events = [],
      c = new ResourceController((event) => events.push(event))
    expect(() =>
      c.firstDom({ html: 'wrong' }, () => {
        throw new Error('first literal mismatch')
      })
    ).toThrow('literal')
    expect(() => c.firstDom({ html: 'later correct' }, () => {})).toThrow('fenced')
    expect(events).toHaveLength(2)
    expect(events[0].firstDom.html).toBe('wrong')
    expect(events[1].later).toBe('NOTRUN')
  })
  it('fences a timed-out operation and its late result, with no accepted sample or stage advance', async () => {
    const events = [],
      c = new ResourceController((event) => events.push(event))
    let late
    await expect(
      c.bounded(
        'GC',
        () =>
          new Promise((resolve) => {
            late = resolve
          }),
        2
      )
    ).rejects.toThrow('timeout')
    late({ usedSize: 123 })
    await Promise.resolve()
    expect(c.samples).toEqual([])
    expect(() => c.accept({ label: 'warm' })).toThrow('fenced')
    await expect(c.bounded('retry', () => {}, 2)).rejects.toThrow('fenced')
    expect(events).toHaveLength(1)
  })
})
