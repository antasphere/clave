import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { validateProfile, summarize } from '../../scripts/performance/renderer-data.mjs'

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
