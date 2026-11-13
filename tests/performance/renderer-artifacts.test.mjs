import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  validateProfile,
  summarize,
  normalizeProfile,
  validateStreamCounts
} from '../../scripts/performance/renderer-data.mjs'

const root = fileURLToPath(new URL('../../docs/performance/renderer-baseline/', import.meta.url))
test('published baseline contains complete repeated workloads and actual scrubbed profiles', () => {
  for (const build of ['installed', 'dev']) {
    const dir = path.join(root, build)
    const text = readFileSync(path.join(dir, 'measurements.json'), 'utf8')
    assert.doesNotMatch(text, /\/Users\/|\/home\/|valentindosimont|Bearer /)
    const m = JSON.parse(text)
    assert.equal(m.build, build)
    assert.equal(m.config.tabs, 24)
    assert.equal(m.config.turns, 200)
    assert.equal(m.config.samples, 30)
    assert.equal(m.config.runs, 5)
    assert.equal(m.runs.length, 5)
    assert.ok(m.completedAt)
    assert.deepEqual(m.summary.startup, summarize(m.runs.map((r) => r.startupMs)))
    for (const r of m.runs) {
      assert.ok(r.ok && r.cleaned)
      assert.deepEqual(r.pageErrors, [])
      assert.equal(r.close.timedOut, false)
      assert.equal(r.identity.visible, false)
      assert.equal(r.identity.backgroundThrottling, false)
      assert.equal(r.server.mode, 'separate')
      assert.ok(r.emptyIdle.elapsedMs >= 4900 && r.loadedIdle.elapsedMs >= 4900)
      for (const pass of ['unsampled', 'sampled']) {
        for (const kind of ['tab', 'group', 'composer', 'scroll']) {
          assert.equal(r[pass][kind].rawMs.length, 30)
          assert.deepEqual(r[pass][kind].summary, summarize(r[pass][kind].rawMs))
        }
      }
      for (const key of ['startupProfile', 'emptyProfile', 'loadedProfile', 'interactionProfile']) {
        const ref = r[key]
        const raw = gunzipSync(readFileSync(path.join(dir, ref.file + '.gz'))).toString('utf8')
        assert.doesNotMatch(raw, /\/Users\/|\/home\/|valentindosimont|file:\/\/\/|Bearer /)
        const p = JSON.parse(raw)
        const checked = validateProfile(p)
        assert.equal(p.samples.length, ref.samples)
        assert.equal(checked.totalUs / 1000, ref.sampledMs)
        if (r.run === 1) {
          const html = readFileSync(
            path.join(dir, ref.file.replace('.cpuprofile', '.html')),
            'utf8'
          )
          assert.ok(html.includes('<svg'))
          assert.ok(html.includes(`${p.samples.length} samples`))
          assert.doesNotMatch(html, /\/Users\/|file:\/\/\/|valentindosimont/)
        }
      }
    }
    for (const pass of ['unsampled', 'sampled']) {
      for (const kind of ['tab', 'group', 'composer', 'scroll']) {
        assert.deepEqual(
          m.summary[pass][kind],
          summarize(m.runs.flatMap((r) => r[pass][kind].rawMs))
        )
      }
    }
  }
  assert.ok(existsSync(path.join(root, 'report.md')))
})

test('all published JSON, graphs and excluded attempts omit private paths', () => {
  for (const name of readdirSync(root, { recursive: true })) {
    if (!/\.(json|html|gz)$/.test(name)) continue
    const bytes = readFileSync(path.join(root, name))
    const text = (name.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')
    assert.doesNotMatch(text, /\/Users\/|\/home\/|valentindosimont|file:\/\/\/|Bearer /, name)
  }
})

test('100-tab off/on evidence conserves signed profiles and proves delivery', () => {
  for (const build of ['installed', 'dev']) {
    const dir = path.join(root, build + '-100')
    const m = JSON.parse(readFileSync(path.join(dir, 'measurements.json'), 'utf8'))
    assert.equal(m.config.tabs, 100)
    assert.equal(m.config.groups, 10)
    assert.equal(m.config.historyTabs, 20)
    assert.equal(m.config.turns, 200)
    assert.equal(m.config.streaming, true)
    assert.equal(m.config.samples, 30)
    assert.equal(m.runs.length, 3)
    assert.ok(m.completedAt)
    const originals = new Map()
    let originalCount = 0
    for (const name of m.collectionSeries) {
      assert.match(name, /^collection-\d+\/measurements\.json$/)
      const original = JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
      const collection = path.dirname(name)
      assert.ok(!originals.has(collection), 'duplicate collection')
      assert.ok(original.completedAt)
      assert.equal(original.runs.length, original.config.runs)
      assert.deepEqual(original.summary.startup, summarize(original.runs.map((r) => r.startupMs)))
      for (const phase of ['off', 'on']) {
        for (const kind of ['tab', 'composer']) {
          assert.deepEqual(
            original.summary[phase][kind],
            summarize(original.runs.flatMap((r) => r.streaming[phase].timings[kind].rawMs))
          )
        }
      }
      for (const key of ['build', 'source', 'toolingSha256', 'machine', 'protocol'])
        assert.deepEqual(original[key], m[key], key)
      assert.deepEqual({ ...original.config, runs: m.config.runs }, m.config)
      originals.set(collection, original)
      originalCount += original.runs.length
    }
    assert.equal(originalCount, m.runs.length)
    assert.deepEqual(m.summary.startup, summarize(m.runs.map((r) => r.startupMs)))
    const seen = new Set()
    for (const [index, r] of m.runs.entries()) {
      assert.equal(r.run, index + 1)
      const original = originals.get(r.collection)
      assert.ok(original, 'unknown collection')
      const sourceRows = original.runs.filter((row) => row.run === r.originalRun)
      assert.equal(sourceRows.length, 1, 'original run must be unique')
      const key = r.collection + '/' + r.originalRun
      assert.ok(!seen.has(key), 'duplicate pooled run')
      seen.add(key)
      const restored = structuredClone(r)
      restored.run = restored.originalRun
      delete restored.originalRun
      delete restored.collection
      for (const ref of [
        restored.startupProfile,
        restored.streaming.off.profile,
        restored.streaming.on.profile
      ]) {
        for (const field of ['file', 'rawFile']) {
          assert.equal(path.dirname(ref[field]), r.collection)
          ref[field] = path.basename(ref[field])
        }
      }
      assert.deepEqual(restored, sourceRows[0], 'pooled run differs from its original evidence')
      for (const ref of [r.startupProfile, r.streaming.off.profile, r.streaming.on.profile]) {
        const raw = JSON.parse(gunzipSync(readFileSync(path.join(dir, ref.rawFile + '.gz'))))
        const derived = JSON.parse(gunzipSync(readFileSync(path.join(dir, ref.file + '.gz'))))
        const normalized = normalizeProfile(raw)
        assert.deepEqual(derived, normalized.profile)
        assert.deepEqual(ref.normalization, normalized.audit)
        assert.equal(derived.samples.length, ref.samples)
        assert.equal(validateProfile(derived).totalUs / 1000, ref.sampledMs)
      }
      assert.ok(r.ok && r.cleaned && !r.close.timedOut)
      assert.deepEqual(r.pageErrors, [])
      assert.deepEqual(r.streaming.backgroundIndices, [10, 20, 30, 40])
      assert.equal(r.streaming.payloadBytes, 128)
      assert.equal(r.streaming.intervalMs, 50)
      for (const phase of ['off', 'on']) {
        const p = r.streaming[phase]
        const checked = validateStreamCounts(p.produced, p.observedCounts, phase === 'on')
        assert.equal(p.totalEvents, checked.totalEvents)
        assert.equal(p.actualEventsPerSecond, checked.actualEventsPerSecond)
        for (const kind of ['tab', 'composer']) {
          assert.equal(p.timings[kind].rawMs.length, 30)
          assert.deepEqual(p.timings[kind].summary, summarize(p.timings[kind].rawMs))
        }
      }
    }
    for (const phase of ['off', 'on']) {
      for (const kind of ['tab', 'composer']) {
        assert.deepEqual(
          m.summary[phase][kind],
          summarize(m.runs.flatMap((r) => r.streaming[phase].timings[kind].rawMs))
        )
      }
    }
  }
})
