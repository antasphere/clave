/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript benchmark checks */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { checkResponsivenessComparison } from './responsiveness-data.mjs'

function collection(cost) {
  const timings = Object.fromEntries(
    ['tab', 'group', 'composer'].map((k) => [
      k,
      {
        handlerMs: Array(30).fill(k === 'group' ? 65 : 35),
        requestMs: Array(30).fill(25)
      }
    ])
  )
  const phase = (taskMs) => ({
    idle: { taskMs },
    timings,
    observed: ['chunk000001'],
    produced: { chunks: ['chunk000001'] },
    actualEventsPerSecond: 19.5
  })
  return {
    config: { samples: 30 },
    toolingSha256: { tool: 'same' },
    runs: Array.from({ length: 3 }, () => ({
      ok: true,
      pageErrors: [],
      phases: { off: phase(10), on: phase(10 + cost) }
    }))
  }
}
describe('renderer responsiveness acceptance', () => {
  it('validates the published evidence and recomputes its reported verdicts', () => {
    execFileSync(
      process.execPath,
      ['--test', 'tests/performance/responsiveness-artifacts.test.mjs'],
      {
        stdio: 'pipe'
      }
    )
  }, 30_000)
  it('recomputes the median task reduction and pooled native input tails', () => {
    expect(checkResponsivenessComparison(collection(3000), collection(1000)).reduction).toBeCloseTo(
      2 / 3
    )
  })
  it.each([
    'lost stream',
    'reordered stream',
    'changed tooling',
    'slow input',
    'slow group',
    'slow cadence',
    'insufficient reduction'
  ])('refuses %s', (fault) => {
    const before = collection(3000),
      after = collection(1000)
    if (fault === 'lost stream') after.runs[0].phases.on.observed = []
    if (fault === 'reordered stream') {
      after.runs[0].phases.on.observed = ['second', 'first']
      after.runs[0].phases.on.produced.chunks = ['first', 'second']
    }
    if (fault === 'changed tooling') after.toolingSha256.tool = 'changed'
    if (fault === 'slow input')
      after.runs.forEach((r) => {
        r.phases.on.timings.composer.requestMs = Array(30).fill(60)
      })
    if (fault === 'slow group')
      after.runs.forEach((r) => {
        r.phases.on.timings.group.handlerMs = Array(30).fill(80)
      })
    if (fault === 'slow cadence') after.runs[0].phases.on.actualEventsPerSecond = 5
    if (fault === 'insufficient reduction')
      after.runs.forEach((r) => {
        r.phases.on.idle.taskMs = 2010
      })
    expect(() => checkResponsivenessComparison(before, after)).toThrow()
  })
})
