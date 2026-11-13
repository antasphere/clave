/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node and vitest */
// The arithmetic of the backend benchmarks (lane B of clave-perf-20261015,
// issue #188): order statistics over raw samples, and the checks that refuse
// a sample set too thin or too broken to stand behind a number.
//
// Every figure the report prints goes through `summarize`, so the rules hold
// in one place: nearest-rank quantiles over the raw values, p95 only where
// there are at least `P95_MIN_N` of them (below that a p95 is the maximum
// under another name), and a set that is empty, holds a non-finite value, or
// falls short of what the plan asked for is an error, never a figure.

/** The fewest samples a p95 is printed for: with 20, the p95 is the 19th
 *  value and one outlier above it, which is the least that makes it more
 *  than the maximum. */
export const P95_MIN_N = 20
/** Likewise for p99. */
export const P99_MIN_N = 100

export class SampleError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SampleError'
  }
}

/** The `q` quantile of ascending `sorted` by nearest rank: the smallest value
 *  with at least `q` of the set at or below it. No interpolation, so every
 *  quantile printed is a value that was actually measured. */
export function nearestRank(sorted, q) {
  if (sorted.length === 0) throw new SampleError('nearestRank of an empty set')
  if (!(q > 0 && q <= 1)) throw new SampleError(`quantile must be in (0, 1], got ${q}`)
  const rank = Math.ceil(q * sorted.length)
  return sorted[rank - 1]
}

/** Refuse a sample set nothing should be concluded from. `name` says which
 *  measurement it was, so a failed run names what went missing. */
export function requireSamples(name, values, { minN = 1 } = {}) {
  if (!Array.isArray(values)) throw new SampleError(`${name}: samples are not an array`)
  if (values.length === 0) throw new SampleError(`${name}: no samples`)
  const bad = values.findIndex((v) => typeof v !== 'number' || !Number.isFinite(v))
  if (bad >= 0)
    throw new SampleError(`${name}: sample ${bad} is not a finite number (${String(values[bad])})`)
  if (values.length < minN)
    throw new SampleError(`${name}: ${values.length} samples, the plan needs ${minN}`)
  return values
}

/** n, min, max, mean, p50, and p95/p99 where the set supports them (null
 *  otherwise, never a stand-in). Throws a SampleError on a set
 *  `requireSamples` refuses. */
export function summarize(name, values, { minN = 1 } = {}) {
  requireSamples(name, values, { minN })
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((s, v) => s + v, 0) / n
  return {
    n,
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    p50: nearestRank(sorted, 0.5),
    p95: n >= P95_MIN_N ? nearestRank(sorted, 0.95) : null,
    p99: n >= P99_MIN_N ? nearestRank(sorted, 0.99) : null
  }
}

/** An absolute time from a process's `performance.timeOrigin` and one of
 *  its `performance.nodeTiming` offsets, or null when the offset is
 *  unavailable. Node reports -1 for a milestone that has not happened or
 *  does not exist; Electron main has no libuv loop start of its own and
 *  reports `loopStart` -1, which added to the origin would read as a mark
 *  1 ms before the process began. */
export function nodeTimingMark(timeOrigin, offset) {
  if (!Number.isFinite(timeOrigin)) throw new SampleError(`timeOrigin is ${timeOrigin}`)
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) return null
  return timeOrigin + offset
}

/** Refuse a launch's startup marks (ms after launch) when an event loop is
 *  recorded as running before its own process started: a sentinel read as
 *  a time. An unavailable loop mark is null and passes. */
export function requireStartupOrder(name, startup) {
  for (const [loop, proc] of [
    ['mainLoopStartMs', 'mainProcessStartMs'],
    ['serverLoopStartMs', 'serverProcessStartMs']
  ]) {
    const l = startup[loop]
    const p = startup[proc]
    if (l != null && p != null && l < p)
      throw new SampleError(`${name}: ${loop} (${l}) is before ${proc} (${p})`)
  }
  return startup
}

/** CPU used between two readings of a process's cumulative CPU time, as a
 *  percent of ONE core (100 = one core busy throughout, like `top`).
 *  Throws when the wall interval is not positive or the CPU time went
 *  backwards, which is a different process behind the same pid. */
export function cpuPercent(cpuMsBefore, cpuMsAfter, wallMs) {
  if (!(wallMs > 0)) throw new SampleError(`cpuPercent: wall interval ${wallMs} ms`)
  const used = cpuMsAfter - cpuMsBefore
  if (!Number.isFinite(used) || used < 0)
    throw new SampleError(`cpuPercent: cumulative CPU went from ${cpuMsBefore} to ${cpuMsAfter}`)
  return (used / wallMs) * 100
}

/** `ps -o time=` (`[[dd-]hh:]mm:ss.cc`) as milliseconds. */
export function parsePsTime(text) {
  const t = String(text).trim()
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t)
  if (!m) throw new SampleError(`unreadable ps time "${t}"`)
  const [, days = '0', hours = '0', minutes, seconds] = m
  return (
    ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 +
    Math.round(Number(seconds) * 1000)
  )
}

/** One reading of `ps -o pid=,rss=,time= -p <pids>`: pid → { rssKiB, cpuMs }.
 *  A pid asked for and missing from the output is absent from the map; the
 *  caller decides whether that is an exit or a failure. */
export function parsePsRows(text) {
  const out = new Map()
  for (const line of String(text).split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 3 || cols[0] === '') continue
    const pid = Number(cols[0])
    const rssKiB = Number(cols[1])
    if (!Number.isInteger(pid) || !Number.isFinite(rssKiB))
      throw new SampleError(`unreadable ps row "${line.trim()}"`)
    out.set(pid, { rssKiB, cpuMs: parsePsTime(cols[2]) })
  }
  return out
}

/** A histogram of `perf_hooks.monitorEventLoopDelay` as it crosses a wire
 *  (nanoseconds), checked and turned into milliseconds. A histogram that
 *  recorded nothing (`count` 0, or a min above its max, which is what an
 *  unstarted one reports) is refused rather than read as "no delay".
 *
 *  Each recorded value is the whole interval of the monitor's timer, so it
 *  INCLUDES the resolution: an idle loop at 10 ms resolution reads about
 *  10 ms. `excess` is the same quantiles minus `resolutionMs`, the part that
 *  is actual delay; a value a little below zero is a timer that fired early,
 *  kept as measured. */
export function eventLoopDelayMs(name, h, { resolutionMs = 0 } = {}) {
  if (!h || typeof h !== 'object') throw new SampleError(`${name}: no event-loop histogram`)
  const count = Number(h.count)
  if (!(count > 0)) throw new SampleError(`${name}: the event-loop histogram recorded nothing`)
  for (const k of ['min', 'max', 'mean', 'p50', 'p95', 'p99'])
    if (!Number.isFinite(Number(h[k])))
      throw new SampleError(`${name}: event-loop ${k} is ${String(h[k])}`)
  if (Number(h.min) > Number(h.max))
    throw new SampleError(`${name}: event-loop min above max (unstarted histogram)`)
  const ms = (ns) => Number(ns) / 1e6
  const out = {
    count,
    resolutionMs,
    min: ms(h.min),
    mean: ms(h.mean),
    p50: ms(h.p50),
    p95: ms(h.p95),
    p99: ms(h.p99),
    max: ms(h.max)
  }
  out.excess = Object.fromEntries(
    ['p50', 'p95', 'p99', 'max'].map((k) => [k, out[k] - resolutionMs])
  )
  return out
}
