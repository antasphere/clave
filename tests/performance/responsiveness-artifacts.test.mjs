/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript archive checks */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { normalizeProfile } from '../../scripts/performance/renderer-data.mjs'
import {
  responsivenessSummary,
  checkResponsivenessComparison
} from '../../scripts/performance/responsiveness-data.mjs'

const root = fileURLToPath(new URL('../../docs/performance/ui-responsiveness/', import.meta.url))
const read = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('archived responsiveness evidence preserves every byte, profile pair and raw timing', () => {
  const manifest = read('manifest.json')
  const names = Object.keys(manifest.collections)
  assert.equal(names.length, 5, 'retain baseline and all four complete after collections')
  assert.equal(new Set(manifest.files.map((f) => f.file)).size, manifest.files.length)
  for (const item of manifest.files) {
    const bytes = readFileSync(path.join(root, item.file))
    assert.equal(bytes.length, item.bytes, item.file)
    assert.equal(sha(bytes), item.sha256, item.file)
    const original = item.file.endsWith('.gz') ? gunzipSync(bytes) : bytes
    assert.equal(original.length, item.originalBytes, item.file)
    assert.equal(sha(original), item.originalSha256, item.file)
    assert.doesNotMatch(
      original.toString('utf8'),
      /\/Users\/|\/home\/|\/var\/folders\/|file:\/\/\/|valentindosimont|Bearer /,
      item.file
    )
  }
  const baseline = read('before/measurements.json')
  const comparison = read('comparison.json')
  assert.deepEqual(comparison.baseline, responsivenessSummary(baseline.runs))
  for (const name of names) {
    const collection = read(`${name}/measurements.json`)
    assert.equal(collection.runs.length, 3)
    assert.ok(collection.completedAt)
    assert.deepEqual(collection.config, baseline.config)
    assert.deepEqual(collection.toolingSha256, manifest.frozenToolingSha256)
    assert.deepEqual(collection.summary, responsivenessSummary(collection.runs))
    for (const run of collection.runs) {
      assert.ok(run.ok && run.closed && run.cleaned)
      assert.deepEqual(run.pageErrors, [])
      assert.equal(run.identity.visible, false)
      assert.equal(run.identity.throttled, false)
      for (const phase of ['off', 'on']) {
        const data = run.phases[phase]
        assert.deepEqual(data.observed, data.produced.chunks)
        for (const kind of ['tab', 'group', 'composer']) {
          assert.equal(data.timings[kind].handlerMs.length, 30)
          assert.equal(data.timings[kind].requestMs.length, 30)
        }
        const profile = (file) =>
          JSON.parse(gunzipSync(readFileSync(path.join(root, name, file + '.gz'))))
        const normalized = normalizeProfile(profile(data.profile.raw))
        assert.deepEqual(profile(data.profile.normalized), normalized.profile)
        assert.deepEqual(data.profile.audit, normalized.audit)
        const html = readFileSync(
          path.join(root, name, data.profile.normalized.replace('.cpuprofile', '.html')),
          'utf8'
        )
        assert.ok(html.includes('<svg'))
        assert.ok(html.includes(`${normalized.profile.samples.length} samples`))
      }
    }
    if (name === 'before') continue
    const summary = responsivenessSummary(collection.runs)
    const recorded = comparison.collections[name]
    assert.deepEqual(recorded.summary, summary)
    assert.equal(
      recorded.reduction,
      1 - summary.extraTaskMs.p50 / comparison.baseline.extraTaskMs.p50
    )
    let acceptance
    try {
      checkResponsivenessComparison(baseline, collection)
      acceptance = { passed: true }
    } catch (error) {
      acceptance = { passed: false, reason: error.message }
    }
    assert.deepEqual(recorded.acceptance, acceptance, 'preserve failed targets as failed')
  }
})
