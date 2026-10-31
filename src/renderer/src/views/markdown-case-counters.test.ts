import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MarkdownCaseCounters, type CounterReport } from './markdown-case-counters'

// Updated only for the intentional CI deadline/comment change. The original
// 120-append callback and every assertion are preserved.
const originalHash = '71fc411dcb846cb1c35b8f578674a057487dea31de8a31ad4ec7f750cb0b6c58'
const source = (): string =>
  readFileSync(new URL('./markdown-parser-reuse-correctness.test.ts', import.meta.url), 'utf8')

// Remove only the explicit diagnostic additions, not arbitrary assertions.
function inverse(text: string): string {
  expect(text.match(/\/\/ legacy-counter:add-begin/g)).toHaveLength(7)
  expect(text.match(/\/\/ legacy-counter:body-begin/g)).toHaveLength(1)
  return text
    .replace(
      /^[ \t]*\/\/ legacy-counter:add-begin\n[\s\S]*?^[ \t]*\/\/ legacy-counter:add-end\n/gm,
      ''
    )
    .replace(
      /^[ \t]*\/\/ legacy-counter:body-begin\n([\s\S]*?)^[ \t]*\/\/ legacy-counter:body-end\n/gm,
      (_match, body: string) =>
        body
          .split('\n')
          .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
          .join('\n')
    )
    .replace(
      '  options: Parameters<typeof render>[2] = {},\n  diagnostic?: MarkdownCaseCounters',
      '  options: Parameters<typeof render>[2] = {}'
    )
    .replaceAll('compare(input, slot, undefined, diagnostic)', 'compare(input, slot)')
}

function fixture(): {
  counter: MarkdownCaseCounters
  reports: CounterReport[]
  advance: (wall: number, user: number, system: number) => void
} {
  let wall = 0,
    user = 0,
    system = 0
  const reports: CounterReport[] = []
  return {
    counter: new MarkdownCaseCounters({
      now: () => wall,
      cpu: () => ({ user, system }),
      report: (report) => {
        reports.push(report)
      }
    }),
    reports,
    advance: (w, u, s) => {
      wall += w
      user += u
      system += s
    }
  }
}

describe('optional legacy-case diagnostic counters, small controlled helper checks only', () => {
  it('removes mechanically to the exact source and approved CI completion budget', () => {
    const original = inverse(source())
    expect(createHash('sha256').update(original).digest('hex')).toBe(originalHash)
    expect(original).toContain('}, 120_000)')
    expect(source().match(/compare\(input, slot, undefined, diagnostic\)/g)).toHaveLength(2)
  })

  it('keeps exact original expectation expressions and full/reused call order in the optional branch', () => {
    const text = source(),
      original = inverse(text)
    const start = text.indexOf('  if (diagnostic) {')
    const branch = text.slice(start, text.indexOf('  // legacy-counter:add-end', start))
    const expressions = [
      'render(input, undefined, options)',
      'render(input, slot, options)',
      "expect(reused.tree, 'complete document tree/position parity: ' + input).toEqual(full.tree)",
      'expect(reused.html, input).toBe(full.html)',
      'expect(reused.urls, input).toEqual(full.urls)'
    ]
    let previous = -1
    for (const expression of expressions) {
      expect(original).toContain(expression)
      const position = branch.indexOf(expression)
      expect(position).toBeGreaterThan(previous)
      previous = position
    }
    // The original case remains synchronous, with its original proof log and
    // assertions. Inverse equality pins every original expression and message.
    expect(text).not.toContain(
      "it('actually reuses the workload prefix through a substantial sequence with one bounded current state', async"
    )
  })

  it('preserves synchronous return identity, totals/max/units and a separate outer remainder', () => {
    const { counter, reports, advance } = fixture(),
      value = { original: 'unretained-result-sentinel' }
    const returned = counter.run(() => {
      counter.measure('fullRender', () => {
        advance(4, 8000, 1000)
        return value
      })
      expect(
        counter.measure('fullRender', () => {
          advance(2, 3000, 1000)
          return value
        })
      ).toBe(value)
      advance(3, 500, 250)
      counter.setIteration(0)
      counter.tailAttempted()
      advance(1, 100, 50)
      counter.tailCompleted()
      return value
    })
    expect(returned).toBe(value)
    expect(reports).toHaveLength(1)
    const report = reports[0]
    expect(report.callbackState).toBe('callbackReturned')
    expect(report.phases.fullRender).toEqual({
      attempted: 2,
      completed: 2,
      observed: 2,
      wallMsTotal: 6,
      wallMsMax: 4,
      cpuUserUsTotal: 11000,
      cpuUserUsMax: 8000,
      cpuSystemUsTotal: 2000,
      cpuSystemUsMax: 1000
    })
    expect(report.outer.wallMsTotal).toBe(10)
    expect(report.unattributed).toEqual({ wallMs: 4, cpuUserUs: 600, cpuSystemUs: 300 })
    expect(report.tailAccounting).toEqual({ attempted: 1, completed: 1 })
    expect(report.diagnosticsAvailable).toBe(true)
    // Whole-process CPU may exceed wall time; there is no contention metric.
    expect(report.phases.fullRender.cpuUserUsTotal / 1000).toBeGreaterThan(
      report.phases.fullRender.wallMsTotal
    )
    expect(JSON.stringify(report)).not.toContain('unretained-result-sentinel')
  })

  it('records a partial operation and keeps its thrown object without later work', () => {
    const { counter, reports, advance } = fixture(),
      thrown = { original: 'throw' }
    let caught: unknown,
      later = false
    try {
      counter.run(() => {
        counter.setIteration(7)
        counter.measure('treeExpectation', () => {
          advance(5, 300, 200)
          throw thrown
        })
        later = true
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(thrown)
    expect(later).toBe(false)
    expect(reports).toHaveLength(1)
    expect(reports[0].callbackState).toBe('callbackThrew')
    expect(reports[0].currentPhase).toBe('treeExpectation')
    expect(reports[0].iteration).toBe(7)
    expect(reports[0].phases.treeExpectation).toMatchObject({
      attempted: 1,
      completed: 0,
      observed: 1,
      wallMsTotal: 5
    })
    expect(reports[0].outer.completed).toBe(0)
  })

  it('keeps partial tail/accounting counts on an original assertion throw', () => {
    const { counter, reports } = fixture(),
      thrown = Symbol('original assertion')
    let caught: unknown
    try {
      counter.run(() => {
        counter.setIteration(3)
        counter.tailAttempted()
        throw thrown
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(thrown)
    expect(reports[0].tailAccounting).toEqual({ attempted: 1, completed: 0 })
    expect(reports[0].currentPhase).toBe('tailAccountingUnmeasured')
    expect(reports[0].iteration).toBe(3)
  })

  it.each([false, true])(
    'cannot replace return/throw when its reporter fails, throw=%s',
    (throws) => {
      const original = {},
        secondary = {},
        counter = new MarkdownCaseCounters({
          now: () => 1,
          cpu: () => ({ user: 0, system: 0 }),
          report: () => {
            throw secondary
          }
        })
      let caught: unknown, result: unknown
      try {
        result = counter.run(() => {
          if (throws) throw original
          return original
        })
      } catch (error) {
        caught = error
      }
      expect(throws ? caught : result).toBe(original)
      expect(counter.snapshot().reporterFailures).toBe(1)
      expect(counter.snapshot().diagnosticsAvailable).toBe(false)
    }
  )

  it('never reads hostile thrown message/toJSON getters, even with reporter failure', () => {
    let touched = 0
    const thrown = Object.defineProperties(
      {},
      {
        message: {
          get: () => {
            touched++
            throw new Error('forbidden message read')
          }
        },
        toJSON: {
          get: () => {
            touched++
            throw new Error('forbidden serialization')
          }
        }
      }
    )
    const counter = new MarkdownCaseCounters({
      now: () => 1,
      cpu: () => ({ user: 0, system: 0 }),
      report: (report) => {
        JSON.stringify(report)
        throw thrown
      }
    })
    let caught: unknown
    try {
      counter.run(() =>
        counter.measure('reusedRender', () => {
          throw thrown
        })
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(thrown)
    expect(touched).toBe(0)
    expect(counter.snapshot().callbackState).toBe('callbackThrew')
  })

  it('makes clock failures secondary and still runs and returns the original operation', () => {
    const value = {},
      reports: CounterReport[] = []
    const counter = new MarkdownCaseCounters({
      now: () => {
        throw value
      },
      cpu: () => ({ user: 0, system: 0 }),
      report: (report) => {
        reports.push(report)
      }
    })
    let calls = 0
    expect(
      counter.run(() =>
        counter.measure('htmlExpectation', () => {
          calls++
          return value
        })
      )
    ).toBe(value)
    expect(calls).toBe(1)
    expect(reports).toHaveLength(1)
    expect(reports[0].diagnosticsAvailable).toBe(false)
    expect(reports[0].unattributed).toBeNull()
    expect(reports[0].phases.htmlExpectation).toMatchObject({
      attempted: 1,
      completed: 1,
      observed: 0
    })
  })

  it('rejects invalid/backward diagnostic clocks without replacing an original throw', () => {
    const thrown = {}
    let wall = 2
    const counter = new MarkdownCaseCounters({
      now: () => wall--,
      cpu: () => ({ user: 1, system: 0 }),
      report: () => {}
    })
    let caught: unknown
    try {
      counter.run(() => {
        throw thrown
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(thrown)
    expect(counter.snapshot().diagnosticsAvailable).toBe(false)
    expect(counter.snapshot().unattributed).toBeNull()
  })

  it('does not await or inspect an original thenable result and snapshots hold no mutable metric aliases', () => {
    const { counter } = fixture()
    let touched = 0
    const value = Object.defineProperty({}, 'then', {
      get: () => {
        touched++
        throw new Error('must remain synchronous')
      }
    })
    expect(counter.run(() => counter.measure('urlExpectation', () => value))).toBe(value)
    expect(touched).toBe(0)
    const first = counter.snapshot()
    first.phases.urlExpectation.completed = 999
    expect(counter.snapshot().phases.urlExpectation.completed).toBe(1)
  })
})
