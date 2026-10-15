/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript, like the Electron harness. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  summarize,
  validateProfile,
  scrubProfile,
  flamegraph
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
