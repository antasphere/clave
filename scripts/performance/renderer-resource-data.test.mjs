/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript verification tooling */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { EchoAdapter } from '../../src/main/sessions/adapters/echo-adapter'
import { SessionManager } from '../../src/main/sessions/session-manager'
import {
  RESOURCE_CONFIG,
  MILESTONES,
  ResourceController,
  compareResources,
  REQUIRED_TOOLING,
  validateToolingInventory,
  validateResourceSeed
} from './renderer-resource-data.mjs'
import { configureResourcePage } from './renderer-resource.mjs'
import {
  resourceLiteral,
  captureResourceSeed,
  seedResourceWorkload
} from '../../tests/e2e/renderer-resource-workload.mjs'

async function liveSeedFixture() {
  const manager = new SessionManager(),
    adapter = new EchoAdapter()
  manager.registerAdapter(adapter)
  const sessions = [],
    listeners = new Map(),
    streams = new Map(),
    barriers = []
  let groups = 0,
    disposed = 0
  const history = vi.fn(() => ({ items: [] }))
  const app = {
    evaluate: async (_fn, { command }) => {
      if (command === 'createGroup') return { ok: true, result: { groupId: 'group-' + groups++ } }
      if (command !== 'openSession') throw new Error('unexpected seed command')
      const id = 'seed-' + sessions.length
      sessions.push(
        await manager.create({
          id,
          provider: 'echo',
          adapterId: 'echo',
          transport: 'events',
          cwd: '/synthetic-source-only',
          windowKey: 'pure',
          state: 'done',
          createdAt: 1,
          title: id
        })
      )
      streams.set(id, [])
      return { ok: true, result: { sessionId: id } }
    }
  }
  const host = {
    subscribe: (id, listener) => {
      listeners.set(id, listener)
      const off = manager.subscribe(id, listener)
      manager.ready(id)
      return () => {
        off()
        listeners.delete(id)
        disposed++
      }
    }
  }
  vi.stubGlobal('__claveE2E', {
    sessionHost: host,
    echo: {
      inject: (id, packet) => {
        streams.get(id).push(packet.event)
        adapter.inject(id, packet)
      }
    }
  })
  vi.stubGlobal('window', {
    electronAPI: { sessionsList: () => manager.list(), sessionsHistory: history }
  })
  const win = {
    evaluate: async (fn) => fn(),
    locator: (selector) => ({
      click: async () => {},
      waitFor: async () => {},
      filter: ({ hasText }) => ({
        waitFor: async () => {
          const id = selector.match(/data-session-id="([^"]+)"/)[1]
          expect(streams.get(id).at(-2).delta).toContain(hasText)
          barriers.push({ id, hasText })
        }
      })
    })
  }
  const fixture = { evaluate: async (source, args) => Function('return (' + source + ')')()(args) }
  try {
    const workload = await seedResourceWorkload(app, win, fixture, '/synthetic-source-only')
    expect(barriers).toHaveLength(100)
    expect(barriers[19]).toEqual({ id: 'seed-19', hasText: 'Tab 19 turn 199.' })
    expect(listeners.size).toBe(0)
    expect(disposed).toBe(100)
    expect(history).not.toHaveBeenCalled()
    expect(manager.history('seed-0')).toEqual({ items: [], before: null })
    return { workload, sessions: manager.list() }
  } finally {
    vi.unstubAllGlobals()
  }
}

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
  it('observes the unchanged complete live seed and public barriers despite empty adapter history', async () => {
    const { workload, sessions } = await liveSeedFixture()
    expect(workload.seedReceipts.slice(0, 20).every((r) => r.events.length === 200)).toBe(true)
    expect(() => validateResourceSeed(workload, sessions)).not.toThrow()
    for (const mutate of [
      (w) => {
        w.seedReceipts.pop()
      },
      (w) => {
        w.seedReceipts.reverse()
      },
      (w) => {
        w.seedReceipts[0].events.splice(4, 1)
      },
      (w) => {
        w.seedReceipts[0].events.reverse()
      },
      (w) => {
        w.seedReceipts[19].events.splice(199, 1)
      },
      (w) => {
        w.seedReceipts[19].events[199].delta = 'wrong last turn'
      },
      (w) => {
        w.seedReceipts[0].disposed = false
      }
    ]) {
      const bad = structuredClone(workload)
      mutate(bad)
      expect(() => validateResourceSeed(bad, sessions)).toThrow()
    }
    expect(() => validateResourceSeed(workload, [])).toThrow('actual live session query')
    const notDone = structuredClone(sessions)
    notDone[0].state = 'working'
    expect(() => validateResourceSeed(workload, notDone)).toThrow(
      'actual live seeded sessions are done'
    )
  })
  it('removes the live-seed observer on a seed failure and publishes no receipt', async () => {
    const off = vi.fn(),
      listener = vi.fn()
    const host = {
      subscribe: (_id, fn) => {
        listener(fn)
        return off
      }
    }
    await expect(
      captureResourceSeed(host, 'owned', () => {
        throw new Error('seed failed')
      })
    ).rejects.toThrow('seed failed')
    expect(off).toHaveBeenCalledTimes(1)
  })
  it('applies the fixed owned-page locator budget and fences a missing element at 15000ms', async () => {
    vi.useFakeTimers()
    try {
      let defaultMs = 30000
      const page = {
        setDefaultTimeout: vi.fn((ms) => {
          defaultMs = ms
        }),
        locator: () => ({
          waitFor: () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error('locator timeout')), defaultMs)
            })
        })
      }
      configureResourcePage(page)
      expect(page.setDefaultTimeout).toHaveBeenCalledExactlyOnceWith(15000)
      const events = [],
        c = new ResourceController((event) => events.push(event))
      const operation = c.bounded(
        'fixture readiness',
        () => page.locator('#absent').waitFor(),
        RESOURCE_CONFIG.fixtureMs
      )
      const rejected = expect(operation).rejects.toThrow('locator timeout')
      await vi.advanceTimersByTimeAsync(14999)
      expect(c.stopped).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await rejected
      expect(c.stopped).toBe(true)
      expect(c.samples).toEqual([])
      expect(events).toHaveLength(1)
      expect(events[0].later).toBe('NOTRUN')
      await expect(c.bounded('later stage', () => {}, 1)).rejects.toThrow('fenced')
    } finally {
      vi.useRealTimers()
    }
  })
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
  it.each([Infinity, -Infinity, NaN, '1000', 'not a number', null, undefined, -1, 99])(
    'rejects invalid totalSize %s even when the actual raw response matches',
    (totalSize) => {
      const { runs, frozen } = fixture()
      const sample = runs[0].observations[0]
      sample.usage.totalSize = totalSize
      sample.commands[3].result = { ...sample.usage }
      expect(sample.commands[3].result).toEqual(sample.usage)
      expect(() => compareResources(runs, frozen)).toThrow('actual finite usedSize/totalSize')
    }
  )
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
