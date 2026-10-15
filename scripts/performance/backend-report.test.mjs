/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test fixtures */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SampleError } from './backend-stats.mjs'
import { cell, publish, readRun, startupTable } from './backend-report.mjs'

const dirs = []
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'backend-report-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const launch = (boot) => ({ startup: { bootCompleteMs: boot, tabsInGroupsMs: null } })
const runFile = (dir, run) => writeFileSync(path.join(dir, 'raw.json'), JSON.stringify(run))

describe('cell', () => {
  it('gives median and range below 20 values, p50 / p95 from 20 on', () => {
    expect(cell('few', [300, 100, 200])).toBe('200 [100–300] (n=3)')
    const many = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(cell('many', many)).toBe('10.0 / 19.0 (n=20)')
  })
})

describe('readRun', () => {
  it('refuses a run that failed or never finished', () => {
    const d = tmp()
    runFile(d, { status: 'failed', config: {}, plain: [launch(1)] })
    expect(() => readRun(d)).toThrow(/the run failed/)
    runFile(d, { status: 'running', config: {}, plain: [launch(1)] })
    expect(() => readRun(d)).toThrow(SampleError)
  })

  it('refuses a folder without raw data or without a plain launch', () => {
    expect(() => readRun(tmp())).toThrow(/no raw\.json/)
    const d = tmp()
    runFile(d, { status: 'ok', config: {}, plain: [] })
    expect(() => readRun(d)).toThrow(/no plain launch/)
  })

  it('reads a sound run and leaves an absent mark out of the table', () => {
    const d = tmp()
    runFile(d, {
      status: 'ok',
      config: { variant: 'dev-separate', scale: 'S0' },
      plain: [launch(900), launch(1100), launch(1000)]
    })
    const table = startupTable([readRun(d)])
    expect(table).toContain('| window boot complete | 1000 [900–1100] (n=3) |')
    expect(table).toContain('| every seeded tab in its group | – |')
  })
})

describe('publish', () => {
  it('copies the raw data and flamegraphs, gzips the profiles, leaves the rest', () => {
    const src = tmp()
    runFile(src, { status: 'ok', config: {}, plain: [launch(1)] })
    writeFileSync(path.join(src, 'p-idle-main.flame.html'), '<html>&lt;repo&gt;/out</html>')
    writeFileSync(path.join(src, 'p-idle-main.cpuprofile'), '{"nodes":[]}')
    writeFileSync(path.join(src, 'p-idle-main.folded.txt'), 'a;b 1')
    writeFileSync(path.join(src, 'not-published.log'), 'x')
    const dest = tmp()
    publish({ dir: src }, dest)
    const out = path.join(dest, path.basename(src))
    expect(readdirSync(out).sort()).toEqual([
      'p-idle-main.cpuprofile.gz',
      'p-idle-main.flame.html',
      'raw.json'
    ])
    expect(gunzipSync(readFileSync(path.join(out, 'p-idle-main.cpuprofile.gz'))).toString()).toBe(
      '{"nodes":[]}'
    )
  })

  it('refuses every file when one still names a home folder', () => {
    const src = tmp()
    runFile(src, { status: 'ok', config: {}, plain: [launch(1)] })
    writeFileSync(path.join(src, 'p.flame.html'), `<title>f (${os.homedir()}/x.js:1:1)</title>`)
    const dest = tmp()
    expect(() => publish({ dir: src }, dest)).toThrow(/private path/)
    expect(existsSync(path.join(dest, path.basename(src)))).toBe(false)
  })
})
