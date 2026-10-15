/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript, like the Electron harness. */
// Renderer benchmark data checks and a dependency-free sampled-stack flamegraph.
import assert from 'node:assert/strict'

export function summarize(values) {
  assert.ok(Array.isArray(values) && values.length > 0, 'no timing samples')
  assert.ok(
    values.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0),
    'invalid timing sample'
  )
  const sorted = [...values].sort((a, b) => a - b)
  const q = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
  return {
    n: values.length,
    min: sorted[0],
    p50: q(0.5),
    p95: values.length >= 20 ? q(0.95) : null,
    max: sorted.at(-1)
  }
}

export function validateProfile(p) {
  assert.ok(Array.isArray(p?.nodes) && p.nodes.length > 0, 'profile has no nodes')
  assert.ok(Array.isArray(p.samples) && p.samples.length > 0, 'profile has no samples')
  assert.ok(
    Array.isArray(p.timeDeltas) && p.samples.length === p.timeDeltas.length,
    'sample/delta mismatch'
  )
  assert.ok(
    Number.isFinite(p.startTime) && Number.isFinite(p.endTime) && p.endTime > p.startTime,
    'invalid profile clock'
  )
  const nodes = new Map(p.nodes.map((n) => [n.id, n]))
  assert.equal(nodes.size, p.nodes.length, 'duplicate profile node')
  const parents = new Map()
  for (const n of p.nodes) {
    assert.ok(n.callFrame && typeof n.callFrame.functionName === 'string', 'missing call frame')
    for (const id of n.children ?? []) {
      assert.ok(nodes.has(id) && !parents.has(id), 'unknown child or multiple parents')
      parents.set(id, n.id)
    }
  }
  const roots = p.nodes.filter((n) => !parents.has(n.id))
  assert.equal(roots.length, 1, 'profile must have one root')
  for (const id of nodes.keys()) {
    const seen = new Set()
    let current = id
    while (current != null) {
      assert.ok(!seen.has(current), 'profile cycle')
      seen.add(current)
      current = parents.get(current)
    }
    assert.ok(seen.has(roots[0].id), 'disconnected profile node')
  }
  assert.ok(
    p.samples.every((id) => nodes.has(id)),
    'unknown sampled node'
  )
  assert.ok(
    p.timeDeltas.every((x) => Number.isFinite(x) && x >= 0),
    'invalid sample duration'
  )
  const totalUs = p.timeDeltas.reduce((a, b) => a + b, 0)
  assert.ok(totalUs > 0, 'zero sampled duration')
  return { nodes, parents, totalUs }
}

const safeName = (s) =>
  /file:\/\/|\/(?:Users|home|private|tmp|Applications)\/|[A-Za-z]:\\/.test(String(s))
    ? '[path]'
    : String(s)
const safeUrl = (url) => {
  if (!url) return ''
  if (
    /^node:(?:internal\/[a-zA-Z0-9_./-]+|[a-zA-Z0-9_]+|electron\/js2c\/[a-zA-Z0-9_./-]+)$/.test(url)
  )
    return url
  const preload = /\/out\/preload\/([^/?#]+)(?:[?#].*)?$/.exec(url)
  if (preload) return `preload/${preload[1]}`
  const asset = /(?:^|\/)assets\/([^/?#]+)(?:[?#].*)?$/.exec(url)
  return asset ? `assets/${asset[1]}` : '[source]'
}
export function scrubProfile(p) {
  validateProfile(p)
  return {
    nodes: p.nodes.map((n) => ({
      id: n.id,
      callFrame: {
        functionName: safeName(n.callFrame.functionName),
        scriptId: n.callFrame.scriptId ?? '0',
        url: safeUrl(n.callFrame.url),
        lineNumber: n.callFrame.lineNumber,
        columnNumber: n.callFrame.columnNumber
      },
      ...(n.children ? { children: n.children } : {}),
      ...(n.hitCount != null ? { hitCount: n.hitCount } : {})
    })),
    startTime: p.startTime,
    endTime: p.endTime,
    samples: p.samples,
    timeDeltas: p.timeDeltas
  }
}
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]
  )
const frameName = (n) =>
  `${n.callFrame.functionName || '(anonymous)'}${n.callFrame.url ? ` ${n.callFrame.url}:${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber + 1}` : ''}`

export function profileHotspots(p, limit = 15) {
  const { nodes, totalUs } = validateProfile(p)
  const self = new Map()
  p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + p.timeDeltas[i]))
  return [...self]
    .map(([id, us]) => ({
      frame: frameName(nodes.get(id)),
      selfMs: us / 1000,
      percent: (100 * us) / totalUs
    }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, limit)
}

export function flamegraph(p, title) {
  const { nodes, parents, totalUs } = validateProfile(p)
  const totals = new Map()
  p.samples.forEach((id, i) => {
    while (id != null) {
      totals.set(id, (totals.get(id) ?? 0) + p.timeDeltas[i])
      id = parents.get(id)
    }
  })
  const root = p.nodes.find((n) => !parents.has(n.id))
  let maxDepth = 0
  const rects = []
  function draw(id, x, depth) {
    const n = nodes.get(id),
      us = totals.get(id) ?? 0
    if (!us) return
    const w = (1200 * us) / totalUs
    const label = frameName(n)
    maxDepth = Math.max(maxDepth, depth)
    const hue = [...label].reduce((a, c) => (a + c.charCodeAt(0)) % 65, 0)
    rects.push(
      `<g><title>${esc(label)} | ${(us / 1000).toFixed(3)} ms inclusive | ${((100 * us) / totalUs).toFixed(2)}%</title><rect x="${x}" y="${depth * 22}" width="${w}" height="21" fill="hsl(${hue} 80% 70%)" stroke="white" stroke-width=".4"/>${w > 18 ? `<text x="${x + 3}" y="${depth * 22 + 15}" font-size="11">${esc(label.slice(0, Math.floor(w / 6.5)))}</text>` : ''}</g>`
    )
    let childX = x
    for (const child of n.children ?? []) {
      draw(child, childX, depth + 1)
      childX += (1200 * (totals.get(child) ?? 0)) / totalUs
    }
  }
  draw(root.id, 0, 0)
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:14px system-ui;margin:24px;color:#202020}svg{min-width:1200px;width:100%}text{pointer-events:none}g:hover rect{stroke:#111;stroke-width:2}</style><h1>${esc(title)}</h1><p>Aggregated V8 sampled stacks, root at top. Width is inclusive sampled time, not elapsed interaction latency. Hover for frame and source location. Idle/GC/program samples are preserved. ${(totalUs / 1000).toFixed(3)} ms, ${p.samples.length} samples.</p><svg role="img" aria-label="Sampled CPU flamegraph" viewBox="0 0 1200 ${(maxDepth + 1) * 22}">${rects.join('')}</svg></html>`
}
