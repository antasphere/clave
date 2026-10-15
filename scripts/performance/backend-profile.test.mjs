/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test fixtures */
import { describe, expect, it } from 'vitest'
import { SampleError } from './backend-stats.mjs'
import {
  attribute,
  breakdown,
  flamegraphHtml,
  foldProfile,
  foldedText,
  frameLabel,
  appFrames,
  isAppFrame,
  privatePathsIn,
  sampleTimeline,
  scrubProfile,
  scrubText,
  validateCpuProfile
} from './backend-profile.mjs'

const frame = (functionName, url = '', lineNumber = 0) => ({
  functionName,
  url,
  lineNumber,
  columnNumber: 0,
  scriptId: '0'
})

/** (root) → main → { parse → (garbage collector)?, render }, plus (idle).
 *  Samples: parse ×3, render ×1, idle ×2; every delta 1000 µs. */
function fixture() {
  const nodes = [
    { id: 1, callFrame: frame('(root)'), children: [2, 5] },
    {
      id: 2,
      callFrame: frame('main', '/Users/someone/repo/out/main/index.js', 9),
      children: [3, 4]
    },
    { id: 3, callFrame: frame('parse', '/Users/someone/repo/out/main/index.js', 41), children: [] },
    { id: 4, callFrame: frame('render', 'file:///Applications/Clave.app/x.js', 0), children: [] },
    { id: 5, callFrame: frame('(idle)'), children: [] }
  ]
  const samples = [3, 3, 3, 4, 5, 5]
  const timeDeltas = [1000, 1000, 1000, 1000, 1000, 1000]
  const startTime = 0
  // The last sample is taken at 6000; the profile ends 1000 later.
  return { nodes, samples, timeDeltas, startTime, endTime: 7000 }
}

describe('validateCpuProfile', () => {
  it('accepts a sound profile and reports its size', () => {
    expect(validateCpuProfile('p', fixture(), { minSamples: 6 })).toEqual({
      samples: 6,
      durationUs: 7000,
      reordered: 0,
      sampledSpanUs: 6000
    })
  })

  it('accepts out-of-order samples and counts them', () => {
    const p = fixture()
    p.timeDeltas[2] = -4
    expect(validateCpuProfile('p', p, { minSamples: 6 }).reordered).toBe(1)
  })

  it('refuses too few samples: a profiler that barely ran', () => {
    expect(() => validateCpuProfile('p', fixture(), { minSamples: 7 })).toThrow(
      /6 samples, at least 7/
    )
  })

  it('refuses samples and deltas of different lengths', () => {
    const p = fixture()
    p.timeDeltas.pop()
    expect(() => validateCpuProfile('p', p, { minSamples: 1 })).toThrow(/time deltas/)
  })

  it('refuses a sample naming a node that does not exist', () => {
    const p = fixture()
    p.samples[0] = 99
    expect(() => validateCpuProfile('p', p, { minSamples: 1 })).toThrow(/missing node 99/)
  })

  it('refuses a child id that does not exist', () => {
    const p = fixture()
    p.nodes[0].children.push(42)
    expect(() => validateCpuProfile('p', p, { minSamples: 1 })).toThrow(/missing child/)
  })

  it('refuses an empty or zero-length profile and a non-profile', () => {
    expect(() => validateCpuProfile('p', { ...fixture(), nodes: [] })).toThrow(SampleError)
    expect(() => validateCpuProfile('p', { ...fixture(), endTime: 0 }, { minSamples: 1 })).toThrow(
      /duration/
    )
    expect(() => validateCpuProfile('p', null)).toThrow(SampleError)
    expect(() => validateCpuProfile('p', { nodes: [{ id: 1, callFrame: {} }] })).toThrow(
      /samples or timeDeltas/
    )
  })
})

describe('folding the sampled stacks', () => {
  it('weighs each sample by the time to the next one, the last by the end', () => {
    const p = fixture()
    p.timeDeltas = [500, 1000, 2000, 1000, 1000, 1000]
    // The samples land at 500, 1500, 3500, 4500, 5500, 6500; the end is 7000.
    const t = sampleTimeline(p)
    expect(t.times).toEqual([500, 1500, 3500, 4500, 5500, 6500])
    expect(t.weights).toEqual([1000, 2000, 1000, 1000, 1000, 500])
    expect(t.spanUs).toBe(6500)
    expect(t.reordered).toBe(0)
  })

  /** parse, render, idle, parse; the idle sample is logged after render but
   *  taken 4 µs before it (delta -4), as V8 does. */
  const outOfOrder = () => ({
    ...fixture(),
    samples: [3, 4, 5, 3],
    timeDeltas: [1000, 1000, -4, 1000],
    endTime: 5000
  })

  it('sorts an out-of-order sample WITH its timestamp, as DevTools does', () => {
    const t = sampleTimeline(outOfOrder())
    // Absolute times 1000, 2000, 1996, 2996: the idle sample moves before render.
    expect(t.ids).toEqual([3, 5, 4, 3])
    expect(t.times).toEqual([1000, 1996, 2000, 2996])
    expect(t.weights).toEqual([996, 4, 996, 2004])
    expect(t.reordered).toBe(1)
  })

  it('attributes each stack its own time: nothing clamped, nothing moved', () => {
    const p = outOfOrder()
    const folded = foldProfile(p)
    const main = frameLabel(p.nodes[1].callFrame)
    const parse = frameLabel(p.nodes[2].callFrame)
    const render = frameLabel(p.nodes[3].callFrame)
    expect(folded.get(`${main};${parse}`)).toBe(3000)
    expect(folded.get(`${main};${render}`)).toBe(996)
    expect(folded.get('(idle)')).toBe(4)
    // Clamping the -4 to zero instead gives render nothing and idle 1000.
  })

  it('conserves the sampled span whatever the order of the deltas', () => {
    const p = fixture()
    p.timeDeltas = [1000, -30, 2500, -7, 1, 900]
    const t = sampleTimeline(p)
    expect(t.weights.every((w) => w >= 0)).toBe(true)
    expect(t.weights.reduce((s, w) => s + w, 0)).toBe(t.spanUs)
    expect(t.spanUs).toBe(p.endTime - Math.min(...t.times))
    const folded = foldProfile(p)
    expect([...folded.values()].reduce((s, v) => s + v, 0)).toBe(t.spanUs)
    // Every sample is still there, each id as many times as it was taken.
    expect([...t.ids].sort()).toEqual([...p.samples].sort())
  })

  it('gives the last sample nothing when the end is recorded before it', () => {
    const p = { ...fixture(), endTime: 5500 }
    const t = sampleTimeline(p)
    expect(t.weights.at(-1)).toBe(0)
    expect(t.spanUs).toBe(5000)
  })

  it('folds each sample onto its root-to-leaf stack without (root)', () => {
    const folded = foldProfile(fixture())
    const main = frameLabel(fixture().nodes[1].callFrame)
    const parse = frameLabel(fixture().nodes[2].callFrame)
    const render = frameLabel(fixture().nodes[3].callFrame)
    expect(folded.get(`${main};${parse}`)).toBe(3000)
    expect(folded.get(`${main};${render}`)).toBe(1000)
    expect(folded.get('(idle)')).toBe(2000)
    expect([...folded.values()].reduce((s, v) => s + v, 0)).toBe(6000)
  })

  it('labels a frame with its 1-based place', () => {
    expect(frameLabel(frame('f', '/a.js', 9))).toBe('f (/a.js:10:1)')
    expect(frameLabel(frame('', ''))).toBe('(anonymous)')
  })

  it('writes the collapsed format heaviest first and drops empty stacks', () => {
    const text = foldedText(
      new Map([
        ['a;b', 10],
        ['a;c', 30],
        ['z', 0]
      ])
    )
    expect(text).toBe('a;c 30\na;b 10')
  })
})

describe('attribute and breakdown', () => {
  it('splits self time from total time, recursion counted once', () => {
    const { totalUs, rows } = attribute(
      new Map([
        ['a;b;a', 10],
        ['a;c', 30]
      ])
    )
    expect(totalUs).toBe(40)
    const a = rows.find((r) => r.label === 'a')
    expect(a.selfUs).toBe(10)
    expect(a.totalUs).toBe(40)
    expect(rows[0].label).toBe('c')
    expect(rows[0].selfShare).toBeCloseTo(0.75)
  })

  it('separates idle, native, GC and JS time', () => {
    const b = breakdown(
      new Map([
        ['(idle)', 50],
        ['(program)', 10],
        ['x;(garbage collector)', 5],
        ['x;y', 35]
      ])
    )
    expect(b).toEqual({ totalUs: 100, idle: 50, program: 10, gc: 5, js: 35, busyUs: 50 })
  })
})

describe('the app frames', () => {
  const row = (label, selfUs, totalUs) => ({ label, selfUs, totalUs })

  it("are the out/main bundles, from a checkout or from the app's asar", () => {
    expect(isAppFrame('boot (<repo>/out/main/index.js:12:3)')).toBe(true)
    expect(
      isAppFrame('serve (<app>/Contents/Resources/app.asar/out/main/server-entry.js:9:1)')
    ).toBe(true)
    expect(isAppFrame('pipe (<repo>/node_modules/effect/dist/cjs/Function.js:1:1)')).toBe(false)
    expect(isAppFrame('x (<repo>/out/main/chunks/a.js:1:1)')).toBe(true)
    expect(isAppFrame('x (<repo>/out/renderer/assets/a.js:1:1)')).toBe(false)
    expect(isAppFrame('readFileSync (node:fs:433:22)')).toBe(false)
    expect(isAppFrame('(garbage collector)')).toBe(false)
  })

  it('rank the app code by total time, not self time', () => {
    const rows = [
      row('leaf (node:fs:1:1)', 900, 900),
      row('light (<repo>/out/main/index.js:1:1)', 50, 100),
      row('heavy (<repo>/out/main/index.js:2:1)', 1, 800),
      row('dep (<repo>/node_modules/x/y.js:1:1)', 10, 950)
    ]
    expect(appFrames(rows).map((r) => r.label)).toEqual([
      'heavy (<repo>/out/main/index.js:2:1)',
      'light (<repo>/out/main/index.js:1:1)'
    ])
  })
})

describe('scrubbing private paths', () => {
  const roots = [
    ['/Users/someone', '~'],
    ['/Users/someone/repo', '<repo>'],
    ['/Applications/Clave.app', '<app>']
  ]

  it('names the longest root first, file:// forms included', () => {
    expect(scrubText('/Users/someone/repo/out/a.js', roots)).toBe('<repo>/out/a.js')
    expect(scrubText('/Users/someone/.claude/x', roots)).toBe('~/.claude/x')
    expect(scrubText('file:///Applications/Clave.app/x.js', roots)).toBe('<app>/x.js')
  })

  it('scrubs every frame of a profile and leaves nothing private', () => {
    const clean = scrubProfile(fixture(), roots)
    expect(privatePathsIn(JSON.stringify(clean), roots)).toEqual([])
    expect(clean.nodes[1].callFrame.url).toBe('<repo>/out/main/index.js')
  })

  it('finds what a scrub missed: a home folder, a root, a temp folder', () => {
    expect(privatePathsIn('at /Users/other/x.js')).toEqual(['/Users/other'])
    expect(privatePathsIn('/var/folders/ab/cd/T/x', [])).toHaveLength(1)
    expect(privatePathsIn('in /opt/secret/y', [['/opt/secret', '<s>']])).toEqual(['/opt/secret'])
    // The unscrubbed fixture is caught, so the check is able to fail.
    expect(privatePathsIn(JSON.stringify(fixture()), roots).length).toBeGreaterThan(0)
  })
})

describe('flamegraphHtml', () => {
  it('draws one frame per stack element with its share in the tooltip', () => {
    const html = flamegraphHtml(
      new Map([
        ['main;parse', 3000],
        ['main;render', 1000]
      ]),
      { title: 'test <graph>', meta: { variant: 'dev' } }
    )
    expect(html).toContain('<title>test &lt;graph&gt;</title>')
    expect(html).toContain('main — 4.0 ms, 100.00%')
    expect(html).toContain('parse — 3.0 ms, 75.00%')
    expect(html).toContain('render — 1.0 ms, 25.00%')
    expect(html).toContain('<th>variant</th><td>dev</td>')
  })

  it('refuses to draw a profile with no sampled time', () => {
    expect(() => flamegraphHtml(new Map([['a', 0]]), { title: 'empty' })).toThrow(SampleError)
  })
})
