/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript benchmark */
import assert from 'node:assert/strict'
import { summarize } from './renderer-data.mjs'

export function responsivenessSummary(runs) {
  assert.ok(runs.length > 0 && runs.every((r) => r.ok), 'incomplete collection')
  return {
    extraTaskMs: summarize(runs.map((r) => r.phases.on.idle.taskMs - r.phases.off.idle.taskMs)),
    phases: Object.fromEntries(
      ['off', 'on'].map((phase) => [
        phase,
        Object.fromEntries(
          ['tab', 'group', 'composer'].map((kind) => [
            kind,
            {
              handler: summarize(runs.flatMap((r) => r.phases[phase].timings[kind].handlerMs)),
              request: summarize(runs.flatMap((r) => r.phases[phase].timings[kind].requestMs)),
              handlerOver100: runs.flatMap((r) =>
                r.phases[phase].timings[kind].handlerMs.filter((n) => n > 100)
              ),
              requestOver100: runs.flatMap((r) =>
                r.phases[phase].timings[kind].requestMs.filter((n) => n > 100)
              )
            }
          ])
        )
      ])
    )
  }
}

export function checkResponsivenessComparison(before, after) {
  assert.equal(before.runs.length, 3, 'three before launches required')
  assert.equal(after.runs.length, 3, 'three after launches required')
  assert.deepEqual(after.config, before.config, 'workload configuration changed')
  assert.deepEqual(after.toolingSha256, before.toolingSha256, 'measurement tooling changed')
  for (const collection of [before, after])
    for (const run of collection.runs) {
      const phase = run.phases.on
      assert.deepEqual(phase.observed, phase.produced.chunks, 'ordered stream conservation')
      assert.ok(
        phase.actualEventsPerSecond >= 17 && phase.actualEventsPerSecond <= 21,
        'stream cadence differs'
      )
      assert.deepEqual(run.pageErrors, [], 'uncaught renderer errors')
    }
  const baseline = responsivenessSummary(before.runs)
  const candidate = responsivenessSummary(after.runs)
  assert.ok(baseline.extraTaskMs.p50 > 0, 'positive before cost required')
  const reduction = 1 - candidate.extraTaskMs.p50 / baseline.extraTaskMs.p50
  assert.ok(reduction >= 0.6, `extra renderer task reduction ${reduction} < 0.6`)
  const rate = (c) =>
    c.runs.reduce((sum, r) => sum + r.phases.on.actualEventsPerSecond, 0) / c.runs.length
  assert.ok(
    Math.abs(rate(after) / rate(before) - 1) <= 0.1,
    'realized stream rates differ by over 10%'
  )
  assert.ok(candidate.phases.on.composer.request.p95 <= 50, 'native input request p95 exceeds 50ms')
  for (const [kind, ceiling] of [
    ['tab', 50],
    ['group', 75],
    ['composer', 50]
  ])
    assert.ok(
      candidate.phases.on[kind].handler.p95 <= ceiling,
      `${kind} handler p95 exceeds ${ceiling}ms`
    )
  return { reduction, baseline, candidate }
}
