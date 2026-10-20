/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript validation tests */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { normalizeProfile } from './renderer-data.mjs'
import { test } from 'vitest'
import { responsivenessSummary } from './responsiveness-data.mjs'
import {
  APPROVED_RAW_CONTROL_SOURCE,
  APPROVED_RAW_CONTROL_TREE,
  FORMAL_CONFIG,
  FORMAL_RUNTIME_FILES,
  validateRawControlBinding,
  validateFrozenSide,
  validateFrozenPair,
  validateCurrentFrozenSide,
  validateCurrentFrozenPair,
  validateParserCollection,
  checkParserComparison,
  parserLaunchSummaries
} from './parser-responsiveness-data.mjs'
const hash = 'a'.repeat(64)
const rawProfile = {
  nodes: [{ id: 1, callFrame: { functionName: '(root)' }, children: [] }],
  samples: Array(10).fill(1),
  timeDeltas: Array(10).fill(1000),
  startTime: 0,
  endTime: 10000
}
const normalizedProfile = normalizeProfile(rawProfile)
const digest = (p) => createHash('sha256').update(JSON.stringify(p)).digest('hex')
const profiles = { 'x.raw.cpuprofile': rawProfile, 'x.cpuprofile': normalizedProfile.profile }
function validate(c, options = {}) {
  return validateParserCollection(c, { profiles, ...options })
}
function collection(cohort) {
  const timings = () =>
    Object.fromEntries(
      ['tab', 'group', 'composer'].map((k) => [
        k,
        { handlerMs: Array(30).fill(12), requestMs: Array(30).fill(15) }
      ])
    )
  const phase = (on) => ({
    complete: true,
    idle: { taskMs: on ? (cohort === 'before' ? 100 : 30) : 10, elapsedMs: 5000, scriptMs: 1 },
    timings: timings(),
    produced: {
      chunks: on
        ? Array.from(
            { length: 100 },
            (_, i) => `chunk${String(i).padStart(6, '0')} ` + 'a'.repeat(115) + ' '
          )
        : [],
      elapsedMs: 5000,
      ceilingReached: false
    },
    actualEventsPerSecond: on ? 20 : 0,
    profile: {
      raw: 'x.raw.cpuprofile',
      normalized: 'x.cpuprofile',
      audit: normalizedProfile.audit,
      samples: 10,
      intervalUs: 1000,
      rawSha256: digest(rawProfile),
      normalizedSha256: digest(normalizedProfile.profile)
    }
  })
  const c = {
    schema: 2,
    source: cohort === 'before' ? APPROVED_RAW_CONTROL_SOURCE : 'c'.repeat(40),
    mode: 'primary',
    cohort,
    config: { ...FORMAL_CONFIG, profiled: true, mark: 'logo' },
    status: { exitCode: 0, complete: true },
    completedAt: '2026-10-19T00:00:00Z',
    toolingSha256: Object.fromEntries(FORMAL_RUNTIME_FILES.map((f) => [f, hash])),
    provenance: {
      tree: cohort === 'before' ? APPROVED_RAW_CONTROL_TREE : 'd'.repeat(40),
      status: '',
      trackedOverlaySha256: hash,
      buildSha256: { 'out/main/index.js': hash, 'out/renderer/index.html': hash },
      transitiveSha256: Object.fromEntries(
        [...FORMAL_RUNTIME_FILES, 'scripts/performance/responsiveness-data.mjs'].map((f) => [
          f,
          hash
        ])
      ),
      packageLockSha256: hash
    },
    runs: []
  }
  for (let i = 0; i < 3; i++) {
    const off = phase(false),
      on = phase(true)
    off.observed = [...off.produced.chunks]
    on.observed = [...on.produced.chunks]
    c.runs.push({
      run: i + 1,
      ok: true,
      closed: true,
      cleaned: true,
      identity: { visible: false, throttled: false },
      server: { mode: 'separate' },
      load: [1, 2, 3],
      pageErrors: [],
      phases: { off, on }
    })
  }
  c.summary = responsivenessSummary(c.runs)
  c.launchSummaries = parserLaunchSummaries(c)
  return c
}
function frozen(b, a) {
  return {
    before: {
      source: b.source,
      tree: b.provenance.tree,
      buildSha256: b.provenance.buildSha256,
      trackedOverlaySha256: b.provenance.trackedOverlaySha256
    },
    after: {
      source: a.source,
      tree: a.provenance.tree,
      buildSha256: a.provenance.buildSha256,
      trackedOverlaySha256: a.provenance.trackedOverlaySha256
    },
    toolingSha256: b.toolingSha256,
    transitiveSha256: b.provenance.transitiveSha256
  }
}
function compare(b, a) {
  return checkParserComparison(b, a, frozen(b, a), {
    beforeProfiles: profiles,
    afterProfiles: profiles
  })
}
test('strict primary delegates unchanged target comparison and accepts a valid synthetic pair', () =>
  assert.ok(compare(collection('before'), collection('after')).reduction >= 0.6))

test('pins this dated collector to the approved current-dev control source and tree', () => {
  assert.equal(APPROVED_RAW_CONTROL_SOURCE, 'b9114709755e7be5b01ae3de4ae6be2aa88a44e6')
  assert.equal(APPROVED_RAW_CONTROL_TREE, '2f3c8e081c07c0c856148414f300ebfeb564a4ba')
  const b = collection('before'),
    a = collection('after'),
    f = frozen(b, a)
  assert.doesNotThrow(() => validateRawControlBinding(f))
  assert.doesNotThrow(() => validateCurrentFrozenSide(b, f, 'before'))
  assert.doesNotThrow(() => validateCurrentFrozenSide(a, f, 'after'))
})

const bindingNegatives = {
  'matching old AF0 source and f7a tree in receipt and freeze': ({ b, f }) => {
    b.source = f.before.source = 'af0a9f6d1edf595fb6dfcdc82e61f31af8e95555'
    b.provenance.tree = f.before.tree = 'f7a5335209493eb47f64295e6512d29369ac89b0'
  },
  'old4555 receipt and freeze': ({ b, f }) => {
    b.source = f.before.source = '4555de3d125b496ae4d971b1368ae4363640d6ae'
  },
  'same wrong raw source in receipt and freeze': ({ b, f }) => {
    b.source = f.before.source = 'e'.repeat(40)
  },
  'same wrong raw tree in receipt and freeze': ({ b, f }) => {
    b.provenance.tree = f.before.tree = 'e'.repeat(40)
  },
  'missing raw frozen tree': ({ f }) => delete f.before.tree,
  'missing raw receipt tree': ({ b }) => delete b.provenance.tree,
  'missing both raw trees': ({ b, f }) => {
    delete b.provenance.tree
    delete f.before.tree
  },
  'raw receipt tree differs from freeze': ({ b }) => (b.provenance.tree = 'e'.repeat(40)),
  'candidate tree differs from freeze': ({ f }) => (f.after.tree = 'e'.repeat(40)),
  'missing candidate frozen tree': ({ f }) => delete f.after.tree,
  'missing candidate receipt tree': ({ a }) => delete a.provenance.tree,
  'missing both candidate trees': ({ a, f }) => {
    delete a.provenance.tree
    delete f.after.tree
  },
  'non-hex matching candidate source': ({ a, f }) => {
    a.source = f.after.source = 'z'.repeat(40)
  },
  'short candidate frozen source': ({ f }) => (f.after.source = 'c'.repeat(39)),
  'short candidate receipt source': ({ a }) => (a.source = 'c'.repeat(39)),
  'short matching candidate tree': ({ a, f }) => {
    a.provenance.tree = f.after.tree = 'd'.repeat(39)
  },
  'non-hex matching candidate tree': ({ a, f }) => {
    a.provenance.tree = f.after.tree = 'z'.repeat(40)
  }
}
for (const [name, mutate] of Object.entries(bindingNegatives))
  test('rejects frozen binding with ' + name, () => {
    const b = collection('before'),
      a = collection('after'),
      f = structuredClone(frozen(b, a))
    mutate({ b, a, f })
    assert.throws(
      () => checkParserComparison(b, a, f),
      /source HEAD|source tree|raw control tree|exact raw dev BEFORE/
    )
    assert.doesNotThrow(() => compare(collection('before'), collection('after')))
  })

test('candidate collection also requires the approved raw control binding', () => {
  const b = collection('before'),
    a = collection('after'),
    f = structuredClone(frozen(b, a))
  f.before.source = 'e'.repeat(40)
  assert.throws(() => validateCurrentFrozenSide(a, f, 'after'), /exact raw dev BEFORE source/)
})

test('preserves generic historical freezes without imposing current control or tree fields', () => {
  const b = collection('before'),
    a = collection('after')
  b.source = '4555de3d125b496ae4d971b1368ae4363640d6ae'
  const f = structuredClone(frozen(b, a))
  delete f.before.tree
  delete f.after.tree
  assert.doesNotThrow(() => validateFrozenSide(b, f, 'before'))
  assert.doesNotThrow(() => validateFrozenSide(a, f, 'after'))
  assert.doesNotThrow(() => validateFrozenPair(b, a, f))
  assert.throws(() => validateCurrentFrozenSide(b, f, 'before'), /raw control tree/)
  assert.throws(() => validateCurrentFrozenSide(a, f, 'after'), /raw control tree/)
  assert.throws(() => validateCurrentFrozenPair(b, a, f), /raw control tree/)
  assert.throws(() => compare(b, a), /exact raw dev BEFORE source/)
})

test('generic historical bindings retain source, build, overlay and tooling guards', () => {
  const mutations = [
    (a) => (a.source = 'e'.repeat(40)),
    (a) => (a.provenance.buildSha256['out/main/index.js'] = 'e'.repeat(64)),
    (a) => (a.provenance.trackedOverlaySha256 = 'e'.repeat(64)),
    (a) => (a.toolingSha256[FORMAL_RUNTIME_FILES[0]] = 'e'.repeat(64)),
    (a) => (a.provenance.transitiveSha256[FORMAL_RUNTIME_FILES[0]] = 'e'.repeat(64))
  ]
  for (const mutate of mutations) {
    const b = collection('before'),
      a = collection('after')
    b.source = '4555de3d125b496ae4d971b1368ae4363640d6ae'
    const f = structuredClone(frozen(b, a))
    delete f.before.tree
    delete f.after.tree
    mutate(a)
    assert.throws(
      () => validateFrozenPair(b, a, f),
      /frozen source HEAD|frozen actual build|intentional tracked overlay|frozen runtime tooling|frozen transitive tooling/
    )
  }
})
const negatives = {
  'missing phase': (c) => delete c.runs[0].phases.off,
  'incomplete phase': (c) => (c.runs[0].phases.on.complete = false),
  'fake zero exit': (c) => (c.status.exitCode = '0'),
  'failed run': (c) => (c.runs[0].ok = false),
  'no cleanup': (c) => (c.runs[0].closed = false),
  'profile disabled': (c) => (c.config.profiled = false),
  'empty profile': (c) => (c.runs[0].phases.on.profile.samples = 0),
  'wrong interval': (c) => (c.config.profileIntervalUs = 999),
  'wrong logo': (c) => (c.config.mark = 'weaving'),
  'wrong mode': (c) => (c.mode = 'unprofiled'),
  'small cohort': (c) => c.runs.pop(),
  'wrong sample count': (c) => (c.config.samples = 20),
  'sparse sample': (c) => delete c.runs[0].phases.on.timings.tab.handlerMs[0],
  'negative sample': (c) => (c.runs[0].phases.on.timings.tab.requestMs[0] = -1),
  'NaN sample': (c) => (c.runs[0].phases.on.timings.group.handlerMs[0] = NaN),
  'missing tooling': (c) => delete c.toolingSha256[FORMAL_RUNTIME_FILES[0]],
  'bad tooling digest': (c) => (c.toolingSha256[FORMAL_RUNTIME_FILES[0]] = 'bogus'),
  'missing transitive tool': (c) =>
    delete c.provenance.transitiveSha256['scripts/performance/responsiveness-data.mjs'],
  'missing build': (c) => (c.provenance.buildSha256 = {}),
  'changed workload': (c) => (c.config.tabs = 99),
  'stream duplicate': (c) => (c.runs[0].phases.on.observed[1] = c.runs[0].phases.on.observed[0]),
  'off stream': (c) => c.runs[0].phases.off.produced.chunks.push('unexpected'),
  'bad rate': (c) => (c.runs[0].phases.on.actualEventsPerSecond = 16),
  'made-up rate': (c) => (c.runs[0].phases.on.produced.elapsedMs = 6000),
  'truncated collection': (c) => delete c.completedAt,
  'renderer error': (c) => (c.runs[0].pageErrors = ['crash']),
  'deadline ceiling': (c) => (c.runs[0].phases.on.produced.ceilingReached = true),
  'changed summary': (c) => (c.summary.phases.on.tab.handler.p95 = 0)
}
for (const [name, mutate] of Object.entries(negatives))
  test('rejects ' + name, () => {
    const c = collection('after')
    mutate(c)
    assert.throws(() => validate(c))
    assert.doesNotThrow(() => validate(collection('after')))
  })
test('retains a valid primary target miss as FAIL', () => {
  const c = collection('after')
  for (const r of c.runs) r.phases.on.idle.taskMs = 95
  c.summary = responsivenessSummary(c.runs)
  c.launchSummaries = parserLaunchSummaries(c)
  assert.throws(() => compare(collection('before'), c), /reduction/)
  assert.equal(c.runs[0].phases.on.idle.taskMs, 95)
})
test('secondary unprofiled data is disclosed, never formal', () => {
  const c = collection('after')
  c.mode = 'unprofiled'
  c.runs = c.runs.slice(0, 1)
  c.config.profiled = false
  for (const p of Object.values(c.runs[0].phases)) p.profile = null
  c.summary = responsivenessSummary(c.runs)
  c.launchSummaries = parserLaunchSummaries(c)
  assert.doesNotThrow(() => validate(c, { primary: false }))
  assert.throws(() => compare(collection('before'), c))
})

test('requires independently frozen source/build bindings', () => {
  const b = collection('before'),
    a = collection('after'),
    f = structuredClone(frozen(b, a))
  assert.throws(() => checkParserComparison(b, a))
  a.source = 'e'.repeat(40)
  assert.throws(() => checkParserComparison(b, a, f), /source HEAD/)
  assert.doesNotThrow(() => compare(collection('before'), collection('after')))
})

test('requires real profile artifacts and rejects broken pairing', () => {
  const c = collection('after')
  assert.throws(() => validateParserCollection(c), /profile artifacts/)
  assert.throws(() => validateParserCollection(c, { profiles: {} }), /profile artifacts/)
  const bad = structuredClone(profiles)
  bad['x.raw.cpuprofile'].samples[0] = 999
  assert.throws(() => validateParserCollection(c, { profiles: bad }))
  assert.doesNotThrow(() => validate(c))
})
