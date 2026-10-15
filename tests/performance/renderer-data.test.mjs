/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript, like the Electron harness. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  summarize,
  validateProfile,
  scrubProfile,
  flamegraph,
  normalizeProfile,
  validateStreamCounts
} from '../../scripts/performance/renderer-data.mjs'

const profile = () => ({
  nodes: [
    {
      id: 1,
      callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 },
      children: [2]
    },
    {
      id: 2,
      callFrame: {
        functionName: '<script>',
        url: 'file:///Users/private/work/out/renderer/assets/app.js?secret=x',
        lineNumber: 4,
        columnNumber: 5
      }
    }
  ],
  startTime: 100,
  endTime: 400,
  samples: [2, 2],
  timeDeltas: [100, 200]
})
test('timings reject absent or invalid observations; small n never claims p95', () => {
  for (const x of [[], [NaN], [-1], [Infinity], ['3']]) assert.throws(() => summarize(x))
  assert.equal(summarize([1, 9, 4]).p95, null)
  const r = summarize(Array.from({ length: 20 }, (_, i) => i + 1))
  assert.equal(r.p50, 10)
  assert.equal(r.p95, 19)
})
test('profiles require observed samples, valid references and a consistent tree', () => {
  assert.equal(validateProfile(profile()).totalUs, 300)
  const invalid = [
    { ...profile(), samples: [] },
    { ...profile(), timeDeltas: [1] },
    { ...profile(), samples: [99, 2] },
    { ...profile(), timeDeltas: [0, 0] },
    { ...profile(), timeDeltas: [-1, 2] },
    { ...profile(), nodes: [...profile().nodes, profile().nodes[0]] }
  ]
  const cycle = profile()
  cycle.nodes[1].children = [1]
  invalid.push(cycle)
  for (const p of invalid) assert.throws(() => validateProfile(p))
})
test('publication strips private paths and fields and preserves sampled weights', () => {
  const p = profile()
  p.private = '/Users/private/secret'
  p.nodes[1].callFrame.functionName = '/Users/private/name'
  const safe = scrubProfile(p)
  assert.doesNotMatch(JSON.stringify(safe), /Users|private|secret=x/)
  assert.equal(safe.nodes[1].callFrame.url, 'assets/app.js')
  assert.equal(validateProfile(safe).totalUs, 300)
  const html = flamegraph(scrubProfile(profile()), '<script>')
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('0.300 ms'))
  assert.ok(html.includes('assets/app.js:5:6'))
})

test('non-finite profile end clocks cannot be published', () => {
  assert.throws(() => validateProfile({ ...profile(), endTime: Infinity }))
})

test('source scrubbing retains safe runtime and preload attribution', () => {
  const p = profile()
  p.nodes[1].callFrame.url = 'node:internal/modules/esm/utils'
  assert.equal(scrubProfile(p).nodes[1].callFrame.url, 'node:internal/modules/esm/utils')
  p.nodes[1].callFrame.url =
    'file:///Users/private/Clave.app/Contents/Resources/app.asar/out/preload/index.js'
  assert.equal(scrubProfile(p).nodes[1].callFrame.url, 'preload/index.js')
})

test('path-like function names and forged runtime URLs do not bypass scrubbing', () => {
  const p = profile()
  p.nodes[1].callFrame.functionName = 'file:///Users/Jane Doe/private notes.js'
  p.nodes[1].callFrame.url = 'node:/Users/Jane/secret.js'
  const text = JSON.stringify(scrubProfile(p))
  assert.doesNotMatch(text, /Jane|Doe|private|secret|Users/)
})

test('signed intervals preserve timestamp/sample pairing and the exact observed span', () => {
  const p = profile()
  p.nodes[0].children.push(3)
  p.nodes.push({
    id: 3,
    callFrame: { functionName: 'other', url: '', lineNumber: -1, columnNumber: -1 }
  })
  p.samples = [2, 3, 2]
  p.timeDeltas = [100, -4, 204]
  const before = JSON.stringify(p)
  const n = normalizeProfile(p)
  assert.deepEqual(n.profile.samples, [3, 2, 2])
  assert.deepEqual(n.profile.timeDeltas, [96, 4, 200])
  assert.equal(n.audit.totalBeforeUs, 300)
  assert.equal(n.audit.totalAfterUs, 300)
  assert.equal(n.audit.reorderedSamples, 2)
  assert.equal(n.audit.negativeIntervals, 1)
  assert.equal(n.audit.originalSamples, 3)
  assert.equal(JSON.stringify(p), before, 'the raw response remains unchanged')
  assert.deepEqual(scrubProfile(p, { allowSigned: true }).timeDeltas, [100, -4, 204])
  const bad = { ...p, timeDeltas: [100, -4, 1] }
  assert.throws(() => normalizeProfile(bad), /observed span/)
  assert.throws(() => normalizeProfile({ ...p, timeDeltas: [-1, 100, 200] }), /bounds/)
})

test('stream delivery evidence rejects missing, duplicated and absent workloads', () => {
  const p = { elapsedMs: 1000, counts: { a: 20, b: 20, c: 20, d: 20 }, ceilingReached: false }
  assert.deepEqual(validateStreamCounts(p, { ...p.counts }, true), {
    totalEvents: 80,
    actualEventsPerSecond: 80
  })
  assert.throws(() => validateStreamCounts(p, { ...p.counts, a: 19 }, true))
  assert.throws(() => validateStreamCounts(p, { ...p.counts, a: 21 }, true))
  assert.throws(() => validateStreamCounts(p, { a: 20 }, true))
  assert.throws(() => validateStreamCounts({ ...p, ceilingReached: true }, p.counts, true))
  assert.throws(() => validateStreamCounts({ ...p, elapsedMs: 30_001 }, p.counts, true))
  const zero = { ...p, counts: { a: 0, b: 0, c: 0, d: 0 } }
  assert.throws(() => validateStreamCounts(zero, zero.counts, true))
  assert.equal(validateStreamCounts(zero, zero.counts, false).totalEvents, 0)
  assert.throws(() => validateStreamCounts(p, p.counts, false))
})
