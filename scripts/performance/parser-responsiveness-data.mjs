/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript benchmark validation */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { validateProfile, normalizeProfile } from './renderer-data.mjs'
import { responsivenessSummary, checkResponsivenessComparison } from './responsiveness-data.mjs'
// Dated current-dev control. A later dev base requires a reviewed source/freeze update.
export const APPROVED_RAW_CONTROL_SOURCE = 'af0a9f6d1edf595fb6dfcdc82e61f31af8e95555'
export const APPROVED_RAW_CONTROL_TREE = 'f7a5335209493eb47f64295e6512d29369ac89b0'

export function validateRawControlBinding(frozen) {
  assert.ok(frozen?.before, 'root-frozen raw control binding required')
  assert.match(frozen.before.source, /^[a-f0-9]{40}$/, 'raw control source HEAD')
  assert.match(frozen.before.tree, /^[a-f0-9]{40}$/, 'raw control tree')
  assert.equal(frozen.before.source, APPROVED_RAW_CONTROL_SOURCE, 'exact raw dev BEFORE source')
  assert.equal(frozen.before.tree, APPROVED_RAW_CONTROL_TREE, 'exact raw dev BEFORE tree')
}

export const FORMAL_RUNTIME_FILES = [
  'scripts/performance/parser-responsiveness.mjs',
  'scripts/performance/parser-responsiveness-data.mjs',
  'scripts/performance/renderer-data.mjs',
  'tests/e2e/renderer-workload.mjs',
  'tests/e2e/renderer-responsiveness-fixture.mjs',
  'tests/e2e/harness.mjs',
  'tests/e2e/bounds.mjs'
]
export const FORMAL_CONFIG = {
  tabs: 100,
  groups: 10,
  historyTabs: 20,
  turns: 200,
  samples: 30,
  warmups: 5,
  responseBytes: 34380,
  intervalMs: 50,
  payloadBytes: 128,
  idleMs: 5000,
  hidden: true,
  noActivate: true,
  server: 'separate',
  profileIntervalUs: 1000,
  noMachineUsage: true
}
export function digestMap(value, message) {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0,
    message
  )
  for (const hash of Object.values(value)) assert.match(hash, /^[a-f0-9]{64}$/, message)
}
export function validateProvenance(c) {
  assert.match(c.source, /^[a-f0-9]{40}$/, 'source HEAD')
  assert.match(c.provenance?.tree, /^[a-f0-9]{40}$/, 'source tree')
  assert.equal(typeof c.provenance.status, 'string')
  assert.match(c.provenance.trackedOverlaySha256, /^[a-f0-9]{64}$/, 'overlay hash')
  assert.match(c.provenance.packageLockSha256, /^[a-f0-9]{64}$/, 'dependency lock')
  digestMap(c.provenance.buildSha256, 'actual build hashes')
  assert.ok(
    c.provenance.buildSha256['out/main/index.js'] &&
      c.provenance.buildSha256['out/renderer/index.html'],
    'main/renderer build identity'
  )
  digestMap(c.provenance.transitiveSha256, 'transitive tool hashes')
  digestMap(c.toolingSha256, 'runtime tool hashes')
  for (const [name, hash] of Object.entries(c.toolingSha256))
    assert.equal(c.provenance.transitiveSha256[name], hash, 'runtime/transitive hash mismatch')
}
function nonnegative(value, message) {
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, message)
}
export function validateParserCollection(c, { primary = true, profiles } = {}) {
  assert.equal(c.schema, 2)
  assert.deepEqual(
    c.status,
    { exitCode: 0, complete: true },
    'actual numeric successful status required'
  )
  assert.ok(
    typeof c.completedAt === 'string' && Number.isFinite(Date.parse(c.completedAt)),
    'completed collection'
  )
  assert.ok(['before', 'after'].includes(c.cohort), 'cohort')
  assert.ok(['primary', 'profiled', 'unprofiled', 'orb'].includes(c.mode), 'mode')
  if (primary) assert.equal(c.mode, 'primary', 'secondary cannot replace formal')
  const profiled = c.mode !== 'unprofiled',
    mark = c.mode === 'orb' ? 'weaving' : 'logo'
  assert.deepEqual(c.config, { ...FORMAL_CONFIG, profiled, mark }, 'fixed formal configuration')
  assert.equal(
    c.runs.length,
    c.mode === 'primary' || c.mode === 'orb' ? 3 : 1,
    'fresh launch count'
  )
  assert.deepEqual(
    Object.keys(c.toolingSha256).sort(),
    [...FORMAL_RUNTIME_FILES].sort(),
    'exact seven-file runtime set'
  )
  validateProvenance(c)
  assert.ok(
    c.provenance.transitiveSha256['scripts/performance/responsiveness-data.mjs'],
    'strict inherited comparison dependency'
  )
  for (const [i, r] of c.runs.entries()) {
    assert.equal(r.run, i + 1, 'ordered launches')
    for (const k of ['ok', 'closed', 'cleaned']) assert.equal(r[k], true, k)
    assert.deepEqual(r.pageErrors, [], 'renderer errors')
    assert.equal(r.identity.visible, false)
    assert.equal(r.identity.throttled, false)
    assert.equal(r.server.mode, 'separate')
    assert.equal(r.load.length, 3)
    for (const value of r.load) nonnegative(value, 'load sample')
    assert.deepEqual(Object.keys(r.phases).sort(), ['off', 'on'])
    for (const [phase, p] of Object.entries(r.phases)) {
      assert.equal(p.complete, true, 'phase completion')
      for (const k of ['taskMs', 'elapsedMs', 'scriptMs']) nonnegative(p.idle[k], 'task window')
      assert.ok(p.idle.elapsedMs >= 4900, 'complete five-second task window')
      for (const kind of ['tab', 'group', 'composer'])
        for (const clock of ['handlerMs', 'requestMs']) {
          const samples = p.timings[kind][clock]
          assert.equal(samples.length, 30, 'thirty samples')
          for (const value of samples) nonnegative(value, 'dense nonnegative samples')
        }
      assert.equal(p.produced.ceilingReached, false, 'producer ceiling')
      assert.ok(p.produced.elapsedMs > 0 && p.produced.elapsedMs < 90000, 'producer duration')
      assert.deepEqual(p.observed, p.produced.chunks, 'ordered conservation')
      const rate = p.observed.length / (p.produced.elapsedMs / 1000)
      assert.equal(p.actualEventsPerSecond, rate, 'rate from actual raw duration')
      if (phase === 'on') {
        assert.ok(p.observed.length >= 100 && rate >= 17 && rate <= 21, 'stream cadence')
        for (const [index, chunk] of p.observed.entries())
          assert.equal(
            chunk,
            `chunk${String(index).padStart(6, '0')} ` + 'a'.repeat(115) + ' ',
            'exact numbered 128-byte delta'
          )
      } else assert.deepEqual(p.observed, [], 'stream-off control')
      if (profiled) {
        const raw = profiles?.[p.profile?.raw],
          normalized = profiles?.[p.profile?.normalized]
        assert.ok(raw && normalized, 'actual raw and normalized profile artifacts required')
        validateProfile(raw, { allowSigned: true })
        validateProfile(normalized)
        for (const id of raw.samples)
          assert.ok(typeof id === 'number' && Number.isFinite(id), 'dense actual profile samples')
        const digest = (p) => createHash('sha256').update(JSON.stringify(p)).digest('hex')
        assert.equal(p.profile.rawSha256, digest(raw), 'raw profile digest')
        assert.equal(p.profile.normalizedSha256, digest(normalized), 'normalized profile digest')
        assert.equal(p.profile.samples, raw.samples.length, 'actual raw profile count')
        const checked = normalizeProfile(raw)
        assert.deepEqual(normalized, checked.profile, 'raw/normalized profile pairing')
        assert.deepEqual(p.profile.audit, checked.audit, 'profile normalization audit')
        assert.ok(
          p.profile?.samples > 0 && Number.isInteger(p.profile.samples),
          'nonempty actual CPU profile'
        )
        assert.equal(p.profile.intervalUs, 1000)
        assert.ok(p.profile.raw && p.profile.normalized && p.profile.audit, 'profile artifacts')
      } else assert.equal(p.profile, null, 'disclosed no CPU profile')
    }
  }
  const summary = responsivenessSummary(c.runs)
  assert.deepEqual(c.summary, summary, 'summary must match raw samples')
  assert.deepEqual(
    c.launchSummaries,
    parserLaunchSummaries(c),
    'per-launch tails must match raw samples'
  )
  return summary
}
export function validateFrozenSide(c, frozen, key) {
  assert.ok(frozen?.[key], 'root-frozen source/build binding required')
  validateRawControlBinding(frozen)
  assert.match(c.source, /^[a-f0-9]{40}$/, 'source HEAD')
  assert.match(frozen[key].source, /^[a-f0-9]{40}$/, 'frozen source HEAD')
  assert.match(c.provenance?.tree, /^[a-f0-9]{40}$/, 'source tree')
  assert.match(frozen[key].tree, /^[a-f0-9]{40}$/, 'frozen source tree')
  assert.equal(c.source, frozen[key].source, 'frozen source HEAD')
  assert.equal(c.provenance.tree, frozen[key].tree, 'frozen source tree')
  assert.deepEqual(c.provenance.buildSha256, frozen[key].buildSha256, 'frozen actual build')
  assert.equal(
    c.provenance.trackedOverlaySha256,
    frozen[key].trackedOverlaySha256,
    'intentional tracked overlay'
  )
  assert.deepEqual(c.toolingSha256, frozen.toolingSha256, 'frozen runtime tooling')
  assert.deepEqual(
    c.provenance.transitiveSha256,
    frozen.transitiveSha256,
    'frozen transitive tooling'
  )
}
export function validateFrozenPair(before, after, frozen) {
  assert.ok(frozen?.before && frozen?.after, 'root-frozen source/build bindings required')
  validateFrozenSide(before, frozen, 'before')
  validateFrozenSide(after, frozen, 'after')
}
export function parserLaunchSummaries(c) {
  return c.runs.map((r) => ({ run: r.run, ...responsivenessSummary([r]) }))
}
export function checkParserComparison(
  before,
  after,
  frozen,
  { beforeProfiles, afterProfiles } = {}
) {
  validateFrozenPair(before, after, frozen)
  assert.equal(before.cohort, 'before')
  assert.equal(after.cohort, 'after')
  validateParserCollection(before, { profiles: beforeProfiles })
  validateParserCollection(after, { profiles: afterProfiles })
  assert.deepEqual(
    before.provenance.transitiveSha256,
    after.provenance.transitiveSha256,
    'transitive tooling changed'
  )
  // Preserve the strict accepted comparison, thresholds and pooled clocks.
  return checkResponsivenessComparison(before, after)
}
