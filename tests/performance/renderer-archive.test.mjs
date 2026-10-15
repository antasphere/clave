/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript, like the Electron harness. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { normalizeProfile, summarize } from '../../scripts/performance/renderer-data.mjs'

const script = fileURLToPath(
  new URL('../../scripts/performance/renderer-archive.mjs', import.meta.url)
)
test('archive preserves fixture observations and rejects incompatible collections', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'renderer-archive-fixture-'))
  const put = (p, value) => writeFileSync(p, JSON.stringify(value))
  const source = (name, rawMs) => {
    const dir = path.join(root, name)
    mkdirSync(dir)
    const raw = {
      startTime: 100,
      endTime: 400,
      nodes: [
        {
          id: 1,
          callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 },
          children: [2]
        },
        {
          id: 2,
          callFrame: {
            functionName: 'fixture',
            url: 'assets/fixture.js',
            lineNumber: 0,
            columnNumber: 0
          }
        }
      ],
      samples: [2, 2],
      timeDeltas: [100, 200]
    }
    const n = normalizeProfile(raw)
    put(path.join(dir, 'fixture.raw.cpuprofile'), raw)
    put(path.join(dir, 'fixture.cpuprofile'), n.profile)
    const profile = {
      file: 'fixture.cpuprofile',
      rawFile: 'fixture.raw.cpuprofile',
      normalization: n.audit,
      samples: 2,
      sampledMs: 0.3
    }
    const phase = (enabled) => ({
      produced: {
        elapsedMs: 1000,
        counts: {
          a: enabled ? 20 : 0,
          b: enabled ? 20 : 0,
          c: enabled ? 20 : 0,
          d: enabled ? 20 : 0
        },
        ceilingReached: false
      },
      observedCounts: {
        a: enabled ? 20 : 0,
        b: enabled ? 20 : 0,
        c: enabled ? 20 : 0,
        d: enabled ? 20 : 0
      },
      totalEvents: enabled ? 80 : 0,
      actualEventsPerSecond: enabled ? 80 : 0,
      timings: {
        tab: { rawMs, summary: summarize(rawMs) },
        composer: { rawMs, summary: summarize(rawMs) }
      },
      profile
    })
    const m = {
      build: 'dev',
      source: 'synthetic fixture',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:00:01Z',
      config: { runs: 1, streaming: true, samples: 2 },
      toolingSha256: { fixture: 'same bytes' },
      protocol: {},
      machine: {},
      runs: [
        {
          run: 1,
          ok: true,
          cleaned: true,
          close: { timedOut: false },
          pageErrors: [],
          startupMs: rawMs[0],
          startupProfile: profile,
          streaming: { off: phase(false), on: phase(true) }
        }
      ]
    }
    put(path.join(dir, 'measurements.json'), m)
    return { dir, m }
  }
  const run = (one, two, out) =>
    spawnSync(process.execPath, [script, '--input', one, '--input', two, '--out', out], {
      encoding: 'utf8',
      timeout: 10_000
    })
  try {
    const one = source('one', [10, 20]),
      two = source('two', [30, 40]),
      out = path.join(root, 'pooled')
    const r = run(one.dir, two.dir, out)
    assert.equal(r.error, undefined)
    assert.equal(r.status, 0, r.stderr)
    const p = JSON.parse(readFileSync(path.join(out, 'measurements.json'), 'utf8'))
    assert.equal(p.runs.length, 2)
    assert.deepEqual(
      p.runs.map((x) => x.originalRun),
      [1, 1]
    )
    assert.deepEqual(p.collectionSeries, [
      'collection-1/measurements.json',
      'collection-2/measurements.json'
    ])
    assert.deepEqual(p.summary.on.tab, { n: 4, min: 10, p50: 20, p95: null, max: 40 })
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(out, 'collection-1/measurements.json'))),
      one.m
    )
    assert.ok(existsSync(path.join(out, 'collection-1/fixture.raw.cpuprofile.gz')))
    for (const patch of [
      { source: 'other' },
      { toolingSha256: { fixture: 'changed' } },
      { completedAt: null },
      { config: { ...two.m.config, samples: 99 } }
    ]) {
      put(path.join(two.dir, 'measurements.json'), { ...two.m, ...patch })
      const target = path.join(root, 'refused')
      const bad = run(one.dir, two.dir, target)
      assert.equal(bad.error, undefined)
      assert.equal(bad.status, 1, bad.stderr)
      assert.equal(existsSync(target), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
