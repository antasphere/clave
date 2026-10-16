/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript benchmark checks */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { checkResponsivenessComparison, responsivenessSummary } from './responsiveness-data.mjs'

function collection(cost, samples = 30) {
  const timings = () =>
    Object.fromEntries(
      ['tab', 'group', 'composer'].map((k) => [
        k,
        {
          handlerMs: Array(samples).fill(k === 'group' ? 65 : 35),
          requestMs: Array(samples).fill(25)
        }
      ])
    )
  const phase = (taskMs) => ({
    idle: { taskMs },
    timings: timings(),
    observed: ['chunk000001'],
    produced: { chunks: ['chunk000001'] },
    actualEventsPerSecond: 19.5
  })
  const value = {
    config: { samples },
    toolingSha256: { tool: 'same' },
    runs: Array.from({ length: 3 }, () => ({
      ok: true,
      pageErrors: [],
      phases: { off: phase(10), on: phase(10 + cost) }
    }))
  }
  value.summary = responsivenessSummary(value.runs)
  return value
}

const buckets = ['before', 'after'].flatMap((side) =>
  ['off', 'on'].flatMap((phase) =>
    ['tab', 'group', 'composer'].flatMap((kind) =>
      ['handler', 'request'].map((clock) => ({ side, phase, kind, clock }))
    )
  )
)
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
  it('supports the collector minimum of twenty samples without changing formal thirty', () => {
    expect(
      checkResponsivenessComparison(collection(3000, 20), collection(1000, 20)).reduction
    ).toBeCloseTo(2 / 3)
  })
  it.each([1, 6])(
    'refuses %i slow samples per launch instead of accepting null pooled p95',
    (n) => {
      const before = collection(3000, n),
        after = collection(1000, n)
      for (const c of [before, after]) {
        c.config.samples = 30
        for (const run of c.runs)
          for (const phase of ['off', 'on'])
            for (const kind of ['tab', 'group', 'composer'])
              for (const clock of ['handlerMs', 'requestMs'])
                run.phases[phase].timings[kind][clock].fill(1000)
        c.summary = responsivenessSummary(c.runs)
      }
      expect(() => checkResponsivenessComparison(before, after)).toThrow(/sample/)
    }
  )
  it.each(buckets)('refuses one short $side $phase $kind $clock launch masked by pooling', (b) => {
    const pair = { before: collection(3000), after: collection(1000) }
    pair[b.side].runs[0].phases[b.phase].timings[b.kind][b.clock + 'Ms'].splice(1)
    pair[b.side].summary = responsivenessSummary(pair[b.side].runs)
    expect(() => checkResponsivenessComparison(pair.before, pair.after)).toThrow(/sample/)
  })
  it.each(
    buckets.map((b, i) => ({ ...b, invalid: [null, NaN, Infinity, -1, 'slow', undefined][i % 6] }))
  )('refuses invalid timing in $side $phase $kind $clock', (b) => {
    const pair = { before: collection(3000), after: collection(1000) }
    pair[b.side].runs[0].phases[b.phase].timings[b.kind][b.clock + 'Ms'][0] = b.invalid
    expect(() => checkResponsivenessComparison(pair.before, pair.after)).toThrow(/timing sample/)
  })
  it.each(
    buckets.map((b, i) => ({ ...b, invalid: [null, undefined, NaN, Infinity, -1, '25'][i % 6] }))
  )('refuses absent or invalid reported p95 in $side $phase $kind $clock', (b) => {
    const pair = { before: collection(3000), after: collection(1000) }
    pair[b.side].summary.phases[b.phase][b.kind][b.clock].p95 = b.invalid
    expect(() => checkResponsivenessComparison(pair.before, pair.after)).toThrow(/p95/)
  })
  it('refuses a missing percentile object and a sparse timing array', () => {
    const before = collection(3000),
      after = collection(1000)
    delete after.summary.phases.on.tab.handler
    expect(() => checkResponsivenessComparison(before, after)).toThrow(/p95/)
    const complete = collection(1000)
    delete complete.runs[0].phases.off.timings.group.requestMs[2]
    expect(() => checkResponsivenessComparison(before, complete)).toThrow(/timing sample/)
  })
  it('refuses unsupported sample configuration and missing or invalid p50', () => {
    const before = collection(3000),
      after = collection(1000)
    before.config.samples = after.config.samples = 19
    expect(() => checkResponsivenessComparison(before, after)).toThrow(/twenty samples/)
    const a = collection(3000),
      b = collection(1000)
    delete b.summary
    expect(() => checkResponsivenessComparison(a, b)).toThrow(/p95/)
    b.summary = responsivenessSummary(b.runs)
    b.summary.phases.off.group.request.p50 = NaN
    expect(() => checkResponsivenessComparison(a, b)).toThrow(/p50/)
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
    after.summary = responsivenessSummary(after.runs)
    expect(() => checkResponsivenessComparison(before, after)).toThrow()
  })
})
