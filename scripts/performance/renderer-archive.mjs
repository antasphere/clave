#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript, like the Electron harness. */
// Preserve original collections while pooling compatible fresh launches.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'
import path from 'node:path'
import {
  summarize,
  normalizeProfile,
  validateProfile,
  validateStreamCounts,
  flamegraph
} from './renderer-data.mjs'

const { values } = parseArgs({
  options: {
    input: { type: 'string', multiple: true },
    out: { type: 'string' }
  }
})
assert.ok(values.input?.length && values.out, '--input and --out are required')
const inputs = values.input.map((dir) => {
  const text = readFileSync(path.join(dir, 'measurements.json'), 'utf8')
  assert.doesNotMatch(text, /\/Users\/|\/home\/|file:\/\/\/|Bearer /, 'private metadata')
  const m = JSON.parse(text)
  assert.ok(
    m.completedAt && m.config.streaming && m.runs.length === m.config.runs,
    'incomplete streaming collection'
  )
  assert.ok(
    m.runs.every((r) => r.ok && r.cleaned && !r.close.timedOut && r.pageErrors.length === 0),
    'failed collection'
  )
  return { dir, text, m }
})
const first = inputs[0].m
const configWithoutRuns = (cfg) =>
  Object.fromEntries(Object.entries(cfg).filter(([key]) => key !== 'runs'))
for (const { m } of inputs) {
  assert.equal(m.build, first.build, 'different builds')
  assert.equal(m.source, first.source, 'different source revisions')
  assert.deepEqual(
    configWithoutRuns(m.config),
    configWithoutRuns(first.config),
    'different workload'
  )
  assert.deepEqual(m.toolingSha256, first.toolingSha256, 'different measurement implementations')
  assert.deepEqual(m.protocol, first.protocol, 'different protocol')
  assert.deepEqual(m.machine, first.machine, 'different machine')
}
const out = path.resolve(values.out)
mkdirSync(out, { recursive: false })
const pooled = {
  ...first,
  config: { ...first.config, runs: inputs.reduce((n, x) => n + x.m.runs.length, 0) },
  startedAt: inputs.map((x) => x.m.startedAt).sort()[0],
  completedAt: inputs
    .map((x) => x.m.completedAt)
    .sort()
    .at(-1),
  collectionSeries: [],
  runs: []
}
const filename = (name) => {
  assert.ok(
    typeof name === 'string' &&
      name.endsWith('.cpuprofile') &&
      path.basename(name) === name &&
      !name.includes('\\'),
    'unsafe profile reference'
  )
  return name
}
for (const [i, { dir, text, m }] of inputs.entries()) {
  const collection = `collection-${i + 1}`
  const dest = path.join(out, collection)
  mkdirSync(dest)
  writeFileSync(path.join(dest, 'measurements.json'), text)
  pooled.collectionSeries.push(`${collection}/measurements.json`)
  for (const original of m.runs) {
    const row = structuredClone(original)
    row.originalRun = row.run
    row.run = pooled.runs.length + 1
    row.collection = collection
    for (const phase of ['off', 'on']) {
      const p = row.streaming[phase]
      const counts = validateStreamCounts(p.produced, p.observedCounts, phase === 'on')
      assert.equal(p.totalEvents, counts.totalEvents)
      assert.equal(p.actualEventsPerSecond, counts.actualEventsPerSecond)
      for (const kind of ['tab', 'composer']) {
        assert.equal(p.timings[kind].rawMs.length, m.config.samples)
        assert.deepEqual(p.timings[kind].summary, summarize(p.timings[kind].rawMs))
      }
    }
    for (const ref of [row.startupProfile, row.streaming.off.profile, row.streaming.on.profile]) {
      const file = filename(ref.file),
        rawFile = filename(ref.rawFile)
      const derived = JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
      const raw = JSON.parse(readFileSync(path.join(dir, rawFile), 'utf8'))
      const checked = normalizeProfile(raw)
      assert.deepEqual(derived, checked.profile, 'raw/derived sample association differs')
      assert.deepEqual(ref.normalization, checked.audit, 'incorrect normalization audit')
      assert.equal(validateProfile(derived).totalUs / 1000, ref.sampledMs)
      assert.equal(derived.samples.length, ref.samples)
      for (const [name, p] of [
        [file, derived],
        [rawFile, raw]
      ]) {
        const text = JSON.stringify(p)
        assert.doesNotMatch(text, /\/Users\/|\/home\/|file:\/\/\/|Bearer /, 'private profile path')
        writeFileSync(path.join(dest, name + '.gz'), gzipSync(text))
      }
      if (row.run === 1)
        writeFileSync(
          path.join(dest, file.replace('.cpuprofile', '.html')),
          flamegraph(derived, `${first.build} 100 tabs ${file}`)
        )
      ref.file = `${collection}/${file}`
      ref.rawFile = `${collection}/${rawFile}`
    }
    pooled.runs.push(row)
  }
}
pooled.summary = {
  startup: summarize(pooled.runs.map((r) => r.startupMs)),
  ...Object.fromEntries(
    ['off', 'on'].map((phase) => [
      phase,
      Object.fromEntries(
        ['tab', 'composer'].map((kind) => [
          kind,
          summarize(pooled.runs.flatMap((r) => r.streaming[phase].timings[kind].rawMs))
        ])
      )
    ])
  )
}
writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(pooled, null, 2) + '\n')
console.log(
  JSON.stringify({
    build: pooled.build,
    launches: pooled.runs.length,
    originalCollections: pooled.collectionSeries
  })
)
