import { describe, expect, it } from 'vitest'
import {
  P95_MIN_N,
  SampleError,
  cpuPercent,
  eventLoopDelayMs,
  nearestRank,
  nodeTimingMark,
  parsePsRows,
  parsePsTime,
  requireSamples,
  requireStartupOrder,
  summarize
} from './backend-stats.mjs'

describe('nearestRank', () => {
  it('answers a measured value, never an interpolation', () => {
    const sorted = [10, 20, 30, 40]
    expect(nearestRank(sorted, 0.5)).toBe(20)
    expect(nearestRank(sorted, 0.75)).toBe(30)
    expect(nearestRank(sorted, 1)).toBe(40)
    expect(nearestRank([7], 0.95)).toBe(7)
  })

  it('takes the 19th of 20 for p95', () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(nearestRank(sorted, 0.95)).toBe(19)
  })

  it('refuses an empty set and a quantile out of range', () => {
    expect(() => nearestRank([], 0.5)).toThrow(SampleError)
    expect(() => nearestRank([1], 0)).toThrow(SampleError)
    expect(() => nearestRank([1], 1.5)).toThrow(SampleError)
  })
})

describe('requireSamples', () => {
  it('names the measurement that has no samples', () => {
    expect(() => requireSamples('startup.boot', [])).toThrow(/startup\.boot: no samples/)
  })

  it('refuses a non-finite or non-numeric sample', () => {
    expect(() => requireSamples('q', [1, Number.NaN])).toThrow(/sample 1 is not a finite/)
    expect(() => requireSamples('q', [1, Infinity])).toThrow(SampleError)
    expect(() => requireSamples('q', [1, '2'])).toThrow(SampleError)
    expect(() => requireSamples('q', [1, null])).toThrow(SampleError)
  })

  it('refuses fewer samples than the plan', () => {
    expect(() => requireSamples('q', [1, 2], { minN: 3 })).toThrow(/2 samples, the plan needs 3/)
    expect(requireSamples('q', [1, 2, 3], { minN: 3 })).toEqual([1, 2, 3])
  })

  it('refuses something that is not an array', () => {
    expect(() => requireSamples('q', undefined)).toThrow(SampleError)
  })
})

describe('summarize', () => {
  it('prints no p95 below the minimum n', () => {
    const s = summarize('small', [5, 1, 3])
    expect(s).toMatchObject({ n: 3, min: 1, max: 5, p50: 3, p95: null, p99: null })
    expect(s.mean).toBeCloseTo(3)
  })

  it('prints p95 from the minimum n on', () => {
    const values = Array.from({ length: P95_MIN_N }, (_, i) => P95_MIN_N - i)
    const s = summarize('enough', values)
    expect(s.p95).toBe(19)
    expect(s.p99).toBeNull()
  })

  it('passes the refusals of requireSamples through', () => {
    expect(() => summarize('x', [])).toThrow(SampleError)
    expect(() => summarize('x', [1], { minN: 2 })).toThrow(SampleError)
  })
})

describe('cpuPercent', () => {
  it('is a percent of one core', () => {
    expect(cpuPercent(1000, 1500, 1000)).toBe(50)
    expect(cpuPercent(0, 2400, 1000)).toBe(240)
  })

  it('refuses a clock that did not move or CPU that went backwards', () => {
    expect(() => cpuPercent(0, 10, 0)).toThrow(SampleError)
    expect(() => cpuPercent(100, 50, 1000)).toThrow(/went from 100 to 50/)
  })
})

describe('ps parsing', () => {
  it('reads the forms ps prints', () => {
    expect(parsePsTime('0:01.50')).toBe(1500)
    expect(parsePsTime('12:03.25')).toBe(723_250)
    expect(parsePsTime('1:02:03.00')).toBe(3_723_000)
    expect(parsePsTime('2-01:00:00.00')).toBe(49 * 3_600_000)
  })

  it('refuses what it cannot read', () => {
    expect(() => parsePsTime('soon')).toThrow(SampleError)
  })

  it('maps rows by pid and leaves a missing pid out', () => {
    const rows = parsePsRows('  101  20480   0:01.50\n 202 4096 1:00.00\n')
    expect(rows.get(101)).toEqual({ rssKiB: 20480, cpuMs: 1500 })
    expect(rows.get(202)).toEqual({ rssKiB: 4096, cpuMs: 60_000 })
    expect(rows.has(303)).toBe(false)
  })

  it('refuses a garbled row', () => {
    expect(() => parsePsRows('abc def 0:01.00')).toThrow(SampleError)
  })
})

describe('eventLoopDelayMs', () => {
  const h = { count: 10, min: 10e6, max: 50e6, mean: 12e6, p50: 11e6, p95: 20e6, p99: 40e6 }

  it('converts nanoseconds to milliseconds', () => {
    expect(eventLoopDelayMs('main', h)).toEqual({
      count: 10,
      resolutionMs: 0,
      min: 10,
      mean: 12,
      p50: 11,
      p95: 20,
      p99: 40,
      max: 50,
      excess: { p50: 11, p95: 20, p99: 40, max: 50 }
    })
  })

  it('separates the delay from the timer resolution it includes', () => {
    // At 10 ms resolution an idle loop reads about 10 ms: only the excess is delay.
    const d = eventLoopDelayMs('main', h, { resolutionMs: 10 })
    expect(d.p99).toBe(40)
    expect(d.excess).toEqual({ p50: 1, p95: 10, p99: 30, max: 40 })
    // A timer that fired a little early stays as measured, below zero.
    expect(eventLoopDelayMs('main', { ...h, p50: 9.5e6 }, { resolutionMs: 10 }).excess.p50).toBe(
      -0.5
    )
  })

  it('refuses a histogram that recorded nothing', () => {
    expect(() => eventLoopDelayMs('main', { ...h, count: 0 })).toThrow(/recorded nothing/)
    expect(() => eventLoopDelayMs('main', null)).toThrow(SampleError)
  })

  it('refuses the shape of an unstarted histogram', () => {
    // perf_hooks reports min 2^63 and max 0 before it records.
    expect(() => eventLoopDelayMs('main', { ...h, min: 2 ** 63, max: 0 })).toThrow(/unstarted/)
  })

  it('refuses a non-finite field', () => {
    expect(() => eventLoopDelayMs('main', { ...h, p99: Number.NaN })).toThrow(/p99/)
  })
})

describe('nodeTimingMark', () => {
  it('adds a real offset to the origin', () => {
    expect(nodeTimingMark(1000, 25.5)).toBe(1025.5)
    expect(nodeTimingMark(1000, 0)).toBe(1000)
  })

  it("answers null for Node's -1 sentinel, never a mark before the process began", () => {
    // Electron main reports loopStart -1: origin + -1 would read 1 ms before the start.
    expect(nodeTimingMark(1000, -1)).toBeNull()
    expect(nodeTimingMark(1000, Number.NaN)).toBeNull()
    expect(nodeTimingMark(1000, undefined)).toBeNull()
  })

  it('refuses an origin that is not a time', () => {
    expect(() => nodeTimingMark(undefined, 5)).toThrow(SampleError)
  })
})

describe('requireStartupOrder', () => {
  it('passes ordered marks and an unavailable (null) loop mark', () => {
    const ok = {
      mainProcessStartMs: 29,
      mainLoopStartMs: null,
      serverProcessStartMs: 515,
      serverLoopStartMs: 1405
    }
    expect(requireStartupOrder('plain-1', ok)).toBe(ok)
  })

  it('refuses a loop mark before its process start: the -1 sentinel as a time', () => {
    expect(() =>
      requireStartupOrder('plain-1', { mainProcessStartMs: 28.9, mainLoopStartMs: 27.9 })
    ).toThrow(/plain-1: mainLoopStartMs \(27.9\) is before mainProcessStartMs/)
    expect(() =>
      requireStartupOrder('plain-1', { serverProcessStartMs: 515, serverLoopStartMs: 514 })
    ).toThrow(SampleError)
  })
})
