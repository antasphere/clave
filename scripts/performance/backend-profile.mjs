/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node and vitest */
// V8 CPU profiles for the backend benchmarks (lane B of clave-perf-20261015,
// issue #188): checking one is real, folding its SAMPLED stacks, attributing
// time to functions, scrubbing the paths it carries, and drawing it as a
// flamegraph a browser opens with nothing else installed.
//
// A `.cpuprofile` is the JSON V8's profiler answers (`Profiler.stop`, or
// `--cpu-prof`): a call tree (`nodes`, each `{ id, callFrame, children }`),
// the leaf node id of every sample (`samples`) and the microseconds between
// consecutive samples (`timeDeltas`). Every number below comes from those
// samples: a stack's weight is the time the samples landing on it stand for,
// never an estimate from call counts or from the tree's shape.

import { SampleError } from './backend-stats.mjs'

/** Fewer samples than this is a profiler that barely ran: at the default
 *  1 ms interval, a tenth of a second. A caller asks for more where the
 *  window it profiled was longer. */
export const MIN_PROFILE_SAMPLES = 100

/** Throw a SampleError naming what is wrong with `profile`, or answer its
 *  sample count and duration (µs). */
export function validateCpuProfile(name, profile, { minSamples = MIN_PROFILE_SAMPLES } = {}) {
  if (!profile || typeof profile !== 'object') throw new SampleError(`${name}: not a profile`)
  const { nodes, samples, timeDeltas, startTime, endTime } = profile
  if (!Array.isArray(nodes) || nodes.length === 0) throw new SampleError(`${name}: no nodes`)
  if (!Array.isArray(samples) || !Array.isArray(timeDeltas))
    throw new SampleError(`${name}: samples or timeDeltas missing`)
  if (samples.length !== timeDeltas.length)
    throw new SampleError(
      `${name}: ${samples.length} samples against ${timeDeltas.length} time deltas`
    )
  if (samples.length < minSamples)
    throw new SampleError(`${name}: ${samples.length} samples, at least ${minSamples} expected`)
  const ids = new Set()
  for (const node of nodes) {
    if (!Number.isInteger(node?.id) || !node.callFrame)
      throw new SampleError(`${name}: a node without an id or a call frame`)
    ids.add(node.id)
  }
  for (const node of nodes)
    for (const child of node.children ?? [])
      if (!ids.has(child)) throw new SampleError(`${name}: node ${node.id} names a missing child`)
  const missing = samples.find((id) => !ids.has(id))
  if (missing !== undefined)
    throw new SampleError(`${name}: a sample names missing node ${missing}`)
  if (timeDeltas.some((d) => !Number.isFinite(d)))
    throw new SampleError(`${name}: a non-finite time delta`)
  const durationUs = Number(endTime) - Number(startTime)
  if (!(durationUs > 0)) throw new SampleError(`${name}: duration ${durationUs} µs`)
  // Out-of-order samples are V8's own and are ingested, not refused
  // (`sampleTimeline`); how many there were is part of the record.
  const { reordered, spanUs } = sampleTimeline(profile)
  return { samples: samples.length, durationUs, reordered, sampledSpanUs: spanUs }
}

/** The label a frame is folded and attributed under: its function, and
 *  where it is when V8 knows (`fn (url:line:col)`, 1-based like an editor). */
export function frameLabel(callFrame) {
  const fn = callFrame.functionName || '(anonymous)'
  if (!callFrame.url) return fn
  return `${fn} (${callFrame.url}:${callFrame.lineNumber + 1}:${callFrame.columnNumber + 1})`
}

/**
 * Every sample in time order, with the time it stands for (µs), ingested the
 * way Chrome DevTools does (`CPUProfileDataModel`: `convertTimeDeltas`,
 * `sortSamples`, `normalizeTimestamps`):
 *
 *  1. `timeDeltas[i]` is the time from sample i-1 (or `startTime`) to sample
 *     i, SIGNED: V8 can record a sample a few µs before the one logged ahead
 *     of it, and the delta is then negative. The deltas are summed into
 *     absolute timestamps as they are, never clamped.
 *  2. When the timestamps are out of order, the (sample, timestamp) PAIRS are
 *     sorted together by time (stable), so each sample keeps its own stack
 *     and its own time.
 *  3. A sample stands for the time to the next sample; the last one for the
 *     time to `endTime` (or nothing, if the end is recorded before it).
 *
 * So no weight is negative, no sample's time is dropped or moved onto
 * another stack, and the weights add up exactly to the span from the first
 * sample to the end (`spanUs`). The time between `startTime` and the first
 * sample belongs to no sample and is not attributed, as in DevTools.
 * `reordered` counts the out-of-order pairs, for the record.
 */
export function sampleTimeline(profile) {
  const { samples, timeDeltas } = profile
  const n = samples.length
  const at = new Array(n)
  let t = Number(profile.startTime)
  let reordered = 0
  for (let i = 0; i < n; i++) {
    t += timeDeltas[i]
    at[i] = t
    if (i > 0 && at[i] < at[i - 1]) reordered++
  }
  const order = Array.from({ length: n }, (_, i) => i)
  if (reordered > 0) order.sort((a, b) => at[a] - at[b] || a - b)
  const ids = order.map((i) => samples[i])
  const times = order.map((i) => at[i])
  const end = n > 0 ? Math.max(Number(profile.endTime), times[n - 1]) : Number(profile.endTime)
  const weights = times.map((x, k) => (k < n - 1 ? times[k + 1] : end) - x)
  return { ids, times, weights, reordered, spanUs: n > 0 ? end - times[0] : 0 }
}

/** The root-to-leaf frames of every node, by id (the root itself left out:
 *  it is V8's `(root)` and every stack has it). */
function stacksById(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const memo = new Map()
  const stackOf = (id) => {
    if (memo.has(id)) return memo.get(id)
    const node = byId.get(id)
    const up = parent.get(id)
    const frames = up === undefined ? [] : [...stackOf(up), frameLabel(node.callFrame)]
    memo.set(id, frames)
    return frames
  }
  for (const n of profile.nodes) stackOf(n.id)
  return memo
}

/** Collapsed stacks: `frame;frame;frame` → µs, summed over the samples that
 *  landed on that exact stack. The format flamegraph.pl, inferno and
 *  speedscope all read (with the value as the count). */
export function foldProfile(profile) {
  const stacks = stacksById(profile)
  const { ids, weights } = sampleTimeline(profile)
  const folded = new Map()
  ids.forEach((id, i) => {
    const key = stacks.get(id).join(';') || '(root)'
    folded.set(key, (folded.get(key) ?? 0) + weights[i])
  })
  return folded
}

/** `foldProfile` as text, one `stack value` line each, heaviest first. */
export function foldedText(folded) {
  return [...folded.entries()]
    .filter(([, us]) => us > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([stack, us]) => `${stack} ${Math.round(us)}`)
    .join('\n')
}

/** Per frame label: self time (samples whose leaf it is) and total time
 *  (samples with it anywhere on the stack, counted once per sample even when
 *  it recurses). µs, heaviest self first. */
export function attribute(folded) {
  const self = new Map()
  const total = new Map()
  let all = 0
  for (const [stack, us] of folded) {
    all += us
    const frames = stack.split(';')
    const leaf = frames[frames.length - 1]
    self.set(leaf, (self.get(leaf) ?? 0) + us)
    for (const f of new Set(frames)) total.set(f, (total.get(f) ?? 0) + us)
  }
  const rows = [...total.keys()].map((label) => ({
    label,
    selfUs: self.get(label) ?? 0,
    totalUs: total.get(label),
    selfShare: all > 0 ? (self.get(label) ?? 0) / all : 0,
    totalShare: all > 0 ? total.get(label) / all : 0
  }))
  rows.sort((a, b) => b.selfUs - a.selfUs || b.totalUs - a.totalUs)
  return { totalUs: all, rows }
}

/** Is this frame Clave's own code: the bundles electron-vite writes to
 *  `out/main` and its lazy `chunks/` (main, the server entry, the terminal
 *  process), whether run
 *  from a checkout or from the installed app's asar. Dependencies and Node's
 *  internals are not, even when bundled beside it. */
export function isAppFrame(label) {
  return /\/out\/main\/(?:chunks\/)?[^/:]+\.js:\d+:\d+\)$/.test(label)
}

/** The app's own frames by TOTAL time (time spent in them or in what they
 *  called), heaviest first: where in Clave's code the time starts, which the
 *  self-time rows (mostly Node and library leaves) do not say. */
export function appFrames(rows, n = 25) {
  return rows
    .filter((r) => isAppFrame(r.label))
    .sort((a, b) => b.totalUs - a.totalUs)
    .slice(0, n)
}

/** The share of samples V8 files under its own pseudo-frames: `(idle)` (the
 *  thread waiting), `(program)` (native code outside JS) and `(garbage
 *  collector)`. Busy = everything but idle. */
export function breakdown(folded) {
  let all = 0
  const by = { idle: 0, program: 0, gc: 0, js: 0 }
  for (const [stack, us] of folded) {
    all += us
    const leaf = stack.split(';').pop()
    if (leaf === '(idle)') by.idle += us
    else if (leaf === '(program)') by.program += us
    else if (leaf === '(garbage collector)') by.gc += us
    else by.js += us
  }
  return { totalUs: all, ...by, busyUs: all - by.idle }
}

/** Replace each root in `text` with its label, longest root first so a repo
 *  inside the home folder is named as the repo. `roots` is
 *  `[[absolutePath, label], …]`; both `file://` and bare forms are caught. */
export function scrubText(text, roots) {
  const ordered = [...roots].filter(([p]) => p).sort((a, b) => b[0].length - a[0].length)
  let out = String(text)
  for (const [root, label] of ordered) {
    out = out.split(`file://${root}`).join(label)
    out = out.split(root).join(label)
  }
  return out
}

/** A copy of `profile` with every call frame's url scrubbed. */
export function scrubProfile(profile, roots) {
  return {
    ...profile,
    nodes: profile.nodes.map((n) => ({
      ...n,
      callFrame: { ...n.callFrame, url: scrubText(n.callFrame.url ?? '', roots) }
    }))
  }
}

/** The private paths still in `text`: a user's home (`/Users/<name>`), any
 *  of `roots` themselves, and the temporary folders macOS hands out.
 *  Empty means publishable as far as paths go. */
export function privatePathsIn(text, roots = []) {
  const s = String(text)
  const found = new Set()
  for (const m of s.matchAll(/\/Users\/[^/\s"'<>)]+/g)) found.add(m[0])
  for (const m of s.matchAll(/\/(?:private\/)?var\/folders\/[^\s"'<>)]+/g)) found.add(m[0])
  for (const [root] of roots) if (root && s.includes(root)) found.add(root)
  return [...found]
}

const escapeXml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )

/** A tree of the folded stacks: `{ name, value, children: Map }`. */
function treeOf(folded) {
  const root = { name: 'all', value: 0, children: new Map() }
  for (const [stack, us] of folded) {
    if (!(us > 0)) continue
    root.value += us
    let node = root
    for (const frame of stack.split(';')) {
      let child = node.children.get(frame)
      if (!child) {
        child = { name: frame, value: 0, children: new Map() }
        node.children.set(frame, child)
      }
      child.value += us
      node = child
    }
  }
  return root
}

/** A stable warm colour per frame, so the same function is the same colour
 *  in every graph; V8's pseudo-frames in grey. */
function colourOf(name) {
  if (name.startsWith('(')) return '#b8b8b8'
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  const hue = 10 + (h % 45)
  const light = 55 + ((h >>> 8) % 15)
  return `hsl(${hue},85%,${light}%)`
}

/** The flamegraph as a self-contained HTML page: an SVG drawn from the
 *  folded samples (root at the bottom, a frame's width its share of the
 *  sampled time), a tooltip per frame, click to zoom into a frame and
 *  click the root to come back. `meta` is printed above it as key/value
 *  rows (already scrubbed by the caller). Frames under `minShare` of the
 *  whole are dropped from the drawing only; the tables keep them. */
export function flamegraphHtml(folded, { title, meta = {}, minShare = 0.0005 } = {}) {
  const tree = treeOf(folded)
  if (!(tree.value > 0)) throw new SampleError(`${title}: nothing sampled to draw`)
  const width = 1600
  const rowH = 17
  const rects = []
  let depthMax = 0
  const walk = (node, x, depth, path) => {
    const w = (node.value / tree.value) * width
    if (node.value / tree.value < minShare) return
    depthMax = Math.max(depthMax, depth)
    rects.push({ x, w, depth, name: node.name, value: node.value, path })
    let cx = x
    const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
    kids.forEach((k, i) => {
      walk(k, cx, depth + 1, `${path}.${i}`)
      cx += (k.value / tree.value) * width
    })
  }
  walk(tree, 0, 0, '0')
  const height = (depthMax + 1) * rowH
  const totalMs = tree.value / 1000
  const body = rects
    .map((r) => {
      const y = height - (r.depth + 1) * rowH
      const pct = ((r.value / tree.value) * 100).toFixed(2)
      const label = `${r.name} — ${(r.value / 1000).toFixed(1)} ms, ${pct}%`
      const chars = Math.floor((r.w - 6) / 6.5)
      const text =
        chars >= 3
          ? `<text x="${(r.x + 3).toFixed(2)}" y="${y + 12}">${escapeXml(
              r.name.length > chars ? r.name.slice(0, chars - 1) + '…' : r.name
            )}</text>`
          : ''
      return `<g data-p="${r.path}" data-x="${r.x.toFixed(3)}" data-w="${r.w.toFixed(3)}"><title>${escapeXml(label)}</title><rect x="${r.x.toFixed(2)}" y="${y}" width="${Math.max(0.1, r.w).toFixed(2)}" height="${rowH - 1}" fill="${colourOf(r.name)}"/>${text}</g>`
    })
    .join('\n')
  const metaRows = Object.entries({ ...meta, 'sampled time': `${totalMs.toFixed(1)} ms` })
    .map(([k, v]) => `<tr><th>${escapeXml(k)}</th><td>${escapeXml(v)}</td></tr>`)
    .join('')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeXml(title)}</title>
<style>
body{font:12px -apple-system,Helvetica,sans-serif;margin:16px;color:#222}
table{border-collapse:collapse;margin-bottom:10px}th{text-align:left;padding-right:12px;color:#666;font-weight:500}
svg{font:11px Menlo,monospace}g{cursor:pointer}rect{stroke:#fff;stroke-width:.5}text{pointer-events:none;fill:#111}
#hint{color:#666;margin:6px 0}
</style></head><body>
<h2>${escapeXml(title)}</h2><table>${metaRows}</table>
<div id="hint">Width is sampled time. Hover a frame for its time; click to zoom into it, click the bottom frame to reset.</div>
<svg id="fg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${body}
</svg>
<script>
(function(){var W=${width};var gs=[].slice.call(document.querySelectorAll('#fg g'));
function zoom(p,x,w){gs.forEach(function(g){var gp=g.getAttribute('data-p');var r=g.querySelector('rect');var t=g.querySelector('text');
var inside=gp===p||gp.indexOf(p+'.')===0;var below=p.indexOf(gp+'.')===0;
if(!inside&&!below){g.style.display='none';return}g.style.display='';
var gx=parseFloat(g.getAttribute('data-x')),gw=parseFloat(g.getAttribute('data-w'));
var nx=below?0:(gx-x)*W/w,nw=below?W:gw*W/w;r.setAttribute('x',nx);r.setAttribute('width',Math.max(.1,nw));
if(t){t.setAttribute('x',nx+3);var full=g.querySelector('title').textContent.split(' — ')[0];var c=Math.floor((nw-6)/6.5);
t.textContent=c<3?'':(full.length>c?full.slice(0,c-1)+'…':full)}})}
gs.forEach(function(g){g.addEventListener('click',function(){zoom(g.getAttribute('data-p'),parseFloat(g.getAttribute('data-x')),parseFloat(g.getAttribute('data-w')))})})})();
</script>
</body></html>
`
}
