/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript heap validation */
import assert from 'node:assert/strict'
import { constants as bufferConstants } from 'node:buffer'
import { validateProvenance, validateFrozenPair } from './parser-responsiveness-data.mjs'
export const RESOURCE_CONFIG = {
  tabs: 100,
  groups: 10,
  historyTabs: 20,
  turns: 200,
  server: 'separate',
  hidden: true,
  noActivate: true,
  noMachineUsage: true,
  profiled: false,
  responseBytes: 34380,
  payloadBytes: 128,
  intervalMs: 50,
  warmChunks: 500,
  cycleChunks: 20,
  cycles: 5,
  settleMs: 1000,
  gcPasses: 2
}
const finite = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0
export function decodeHeap(raw) {
  const meta = raw?.snapshot?.meta
  assert.ok(
    meta && Array.isArray(raw.nodes) && Array.isArray(raw.edges) && Array.isArray(raw.strings),
    'missing heap graph/metadata'
  )
  const nf = meta.node_fields,
    ef = meta.edge_fields
  assert.ok(Array.isArray(nf) && Array.isArray(ef), 'heap field metadata')
  const field = (fields, key) => {
    const index = fields.indexOf(key)
    assert.ok(index >= 0, 'missing heap field ' + key)
    return index
  }
  const nt = field(nf, 'type'),
    nn = field(nf, 'name'),
    ni = field(nf, 'id'),
    nc = field(nf, 'edge_count'),
    ns = field(nf, 'self_size')
  const et = field(ef, 'type'),
    en = field(ef, 'name_or_index'),
    ed = field(ef, 'to_node')
  assert.equal(raw.nodes.length, raw.snapshot.node_count * nf.length, 'incomplete node table')
  assert.equal(raw.edges.length, raw.snapshot.edge_count * ef.length, 'incomplete edge table')
  const nodes = [],
    ids = new Set()
  let cursor = 0
  for (let offset = 0; offset < raw.nodes.length; offset += nf.length) {
    const type = meta.node_types[nt][raw.nodes[offset + nt]],
      name = raw.strings[raw.nodes[offset + nn]],
      id = raw.nodes[offset + ni],
      count = raw.nodes[offset + nc]
    assert.ok(
      typeof type === 'string' &&
        typeof name === 'string' &&
        Number.isInteger(id) &&
        !ids.has(id) &&
        Number.isInteger(count) &&
        count >= 0 &&
        finite(raw.nodes[offset + ns]),
      'invalid heap node'
    )
    ids.add(id)
    const outgoing = []
    for (let j = 0; j < count; j++, cursor += ef.length) {
      assert.ok(cursor < raw.edges.length, 'incomplete node edges')
      const edgeType = meta.edge_types[et][raw.edges[cursor + et]],
        destination = raw.edges[cursor + ed]
      assert.ok(
        typeof edgeType === 'string' &&
          Number.isInteger(destination) &&
          destination >= 0 &&
          destination < nf.length * raw.snapshot.node_count &&
          destination % nf.length === 0,
        'invalid edge destination/type'
      )
      const nameOrIndex = raw.edges[cursor + en],
        edgeName = ['element', 'hidden'].includes(edgeType)
          ? String(nameOrIndex)
          : raw.strings[nameOrIndex]
      assert.equal(typeof edgeName, 'string', 'edge name')
      outgoing.push({ type: edgeType, name: edgeName, to: destination / nf.length })
    }
    nodes.push({ id, type, name, edges: outgoing })
  }
  assert.equal(cursor, raw.edges.length, 'unclaimed heap edges')
  assert.ok(nodes.length > 0 && nodes[0].type === 'synthetic', 'V8 synthetic root')
  const parent = new Map([[0, null]]),
    queue = [0]
  for (let i = 0; i < queue.length; i++)
    for (const edge of nodes[queue[i]].edges)
      if (edge.type !== 'weak' && !parent.has(edge.to)) {
        parent.set(edge.to, { from: queue[i], edge })
        queue.push(edge.to)
      }
  const properties = (index) =>
    new Map(
      nodes[index].edges
        .filter((e) => e.type === 'property' || e.type === 'context')
        .map((e) => [e.name, e.to])
    )
  const text = (index) => {
    assert.ok(
      Number.isInteger(index) && index >= 0 && index < nodes.length,
      'invalid heap string index'
    )
    const lengths = new Map(),
      references = new Map(),
      active = new Set()
    const pending = [{ index, exit: false }]
    while (pending.length) {
      const frame = pending.pop(),
        node = nodes[frame.index]
      if (frame.exit) {
        const [first, second] = references.get(frame.index)
        const length = lengths.get(first) + lengths.get(second)
        assert.ok(
          Number.isSafeInteger(length) && length <= bufferConstants.MAX_STRING_LENGTH,
          'heap string size exceeds reconstruction runtime limit'
        )
        lengths.set(frame.index, length)
        active.delete(frame.index)
        continue
      }
      if (lengths.has(frame.index)) continue
      assert.ok(!active.has(frame.index), 'cyclic heap string rope')
      if (node.type === 'string') {
        assert.ok(
          !node.edges.some(
            (e) =>
              e.type === 'internal' &&
              ['actual', 'parent', 'first', 'second', 'truncated'].includes(e.name)
          ),
          'unsupported heap string representation'
        )
        lengths.set(frame.index, node.name.length)
        continue
      }
      if (node.type !== 'concatenated string')
        throw new Error('unresolved heap string shape ' + node.type)
      // V8 representation links are internal. Keep them separate from application
      // property/context fields; reject duplicate or wrong-category links.
      const link = (name) => {
        const edges = node.edges.filter((e) => e.name === name)
        assert.ok(
          edges.length === 1 && edges[0].type === 'internal',
          'malformed heap string rope ' + name + ' link'
        )
        return edges[0].to
      }
      const first = link('first'),
        second = link('second')
      references.set(frame.index, [first, second])
      active.add(frame.index)
      pending.push(
        { index: frame.index, exit: true },
        { index: second, exit: false },
        { index: first, exit: false }
      )
    }
    // Validate lengths once per node before expanding a shared DAG. Empty shared
    // subgraphs contribute no output and must not expand exponentially.
    const segments = [],
      stack = [index]
    while (stack.length) {
      const current = stack.pop()
      if (lengths.get(current) === 0) continue
      if (nodes[current].type === 'string') segments.push(nodes[current].name)
      else {
        const [first, second] = references.get(current)
        stack.push(second, first)
      }
    }
    return segments.join('')
  }
  const pathTo = (index) => {
    assert.ok(parent.has(index), 'unreachable strong path')
    const path = []
    for (let at = index; at !== 0; ) {
      const p = parent.get(at)
      path.push({
        nodeId: nodes[at].id,
        type: nodes[at].type,
        name: nodes[at].type === 'string' ? '[string]' : nodes[at].name.slice(0, 160),
        edge: p.edge.name,
        edgeType: p.edge.type
      })
      at = p.from
    }
    return path.reverse()
  }
  return { nodes, parent, properties, text, pathTo }
}
export function inspectPrefixGraph(raw, { expectedInput, closed = false, warm } = {}) {
  const g = decodeHeap(raw),
    matches = [],
    allPrefixes = [],
    contexts = []
  for (let i = 0; i < g.nodes.length; i++) {
    if (!g.parent.has(i) || g.nodes[i].type !== 'object') continue
    const p = g.properties(i)
    if (!p.has('kind') || !p.has('signature') || !p.has('snapshot')) continue
    if (
      g.text(p.get('kind')) !== 'prefix' ||
      g.text(p.get('signature')) !== 'remark-gfm4:singleTilde=true'
    )
      continue
    // Unexpected state fields reveal application-owned history rather than being ignored.
    for (const key of p.keys())
      assert.ok(
        ['kind', 'signature', 'snapshot', '__proto__'].includes(key),
        'unexpected prefix history/previous field ' + key
      )
    const snapshotIndex = p.get('snapshot'),
      s = g.properties(snapshotIndex)
    for (const key of ['input', 'cut', 'line', 'blocks', 'rootStart', 'accounting'])
      assert.ok(s.has(key), 'incomplete prefix ' + key)
    for (const key of s.keys())
      assert.ok(
        ['input', 'cut', 'line', 'blocks', 'rootStart', 'accounting', '__proto__'].includes(key),
        'unexpected snapshot history field ' + key
      )
    const a = g.properties(s.get('accounting'))
    for (const key of [
      'blocks',
      'nodes',
      'sourceSpanCodeUnits',
      'astStringCodeUnits',
      'sourceBytes'
    ])
      assert.ok(a.has(key), 'incomplete accounting ' + key)
    assert.ok(
      g.nodes[s.get('blocks')].type === 'array' ||
        (g.nodes[s.get('blocks')].type === 'object' && g.nodes[s.get('blocks')].name === 'Array'),
      'actual prefix blocks array'
    )
    const input = g.text(s.get('input'))
    const row = {
      nodeId: g.nodes[i].id,
      index: i,
      snapshotId: g.nodes[snapshotIndex].id,
      inputMatches: input === expectedInput,
      path: g.pathTo(i)
    }
    allPrefixes.push(row)
    if (row.inputMatches) matches.push(row)
  }
  for (let i = 0; i < g.nodes.length; i++) {
    if (!g.parent.has(i) || !g.nodes[i].name.includes('Context')) continue
    const p = g.properties(i)
    if (!p.has('snapshot') || !p.has('listeners')) continue
    const state = allPrefixes.find((row) => row.index === p.get('snapshot'))
    if (!state) continue
    const closures = []
    for (let j = 0; j < g.nodes.length; j++)
      if (
        g.parent.has(j) &&
        g.nodes[j].type === 'closure' &&
        g.nodes[j].edges.some((e) => e.type !== 'weak' && e.to === i && e.name === 'context')
      )
        closures.push({ nodeId: g.nodes[j].id, name: g.nodes[j].name, path: g.pathTo(j) })
    assert.ok(
      closures.some((c) => c.name === 'getSnapshot') && closures.some((c) => c.name === 'publish'),
      'unresolved store closure context'
    )
    contexts.push({
      nodeId: g.nodes[i].id,
      stateId: state.nodeId,
      inputMatches: state.inputMatches,
      path: g.pathTo(i),
      closures
    })
  }
  if (closed) {
    assert.ok(
      warm?.matches?.length > 0 && warm?.storeContexts?.length > 0,
      'prior positive warm graph required'
    )
    // All probes close. Any remaining application prefix needs concrete attribution.
    assert.equal(allPrefixes.length, 0, 'post-close live prefix requires retaining-path review')
  } else {
    assert.ok(matches.length > 0, 'positive warm source-shaped match required')
    assert.ok(
      contexts.some((c) => c.inputMatches),
      'positive warm store context attribution required'
    )
  }
  // Actual V8 scope names, React alternate generations and closure boundaries
  // require a separately reviewed first graph. Synthetic success is never qualification.
  return {
    qualified: false,
    reason: 'Actual V8/React retaining-path qualification required',
    matches: matches.map(({ nodeId, snapshotId, inputMatches, path }) => ({
      nodeId,
      snapshotId,
      inputMatches,
      path
    })),
    allPrefixes: allPrefixes.map(({ nodeId, snapshotId, inputMatches, path }) => ({
      nodeId,
      snapshotId,
      inputMatches,
      path
    })),
    storeContexts: contexts
  }
}
export function checkResourceComparison(before, after, frozen) {
  validateFrozenPair(before, after, frozen)
  const expected = [
    'warm',
    ...Array.from({ length: 5 }, (_, i) => [`cycle-${i + 1}-warm`, `cycle-${i + 1}-closed`]).flat(),
    'final-closed'
  ]
  for (const [c, cohort] of [
    [before, 'r2'],
    [after, 'candidate']
  ]) {
    validateProvenance(c)
    assert.equal(c.cohort, cohort)
    assert.deepEqual(c.config, RESOURCE_CONFIG)
    assert.deepEqual(c.status, { exitCode: 0, complete: true })
    assert.equal(c.qualified, true, 'actual graph qualification')
    assert.equal(c.runs.length, 3, 'three fresh launches')
    for (const [i, r] of c.runs.entries()) {
      assert.equal(r.run, i + 1)
      for (const k of ['ok', 'closed', 'cleaned', 'graphQualified']) assert.equal(r[k], true, k)
      assert.deepEqual(r.pageErrors, [])
      assert.deepEqual(
        r.observations.map((o) => o.milestone),
        expected,
        'complete fixed milestones'
      )
      for (const o of r.observations) {
        assert.ok(
          finite(o.usedSize) && o.usedSize > 0 && finite(o.totalSize) && o.totalSize >= o.usedSize,
          'actual heap sizes'
        )
        for (const key of ['embedderHeapUsedSize', 'backingStorageSize'])
          if (key in o) assert.ok(finite(o[key]), key)
      }
    }
  }
  const values = (c) => c.runs.map((r) => r.observations[0].usedSize),
    median = (ns) => [...ns].sort((a, b) => a - b)[1]
  const baseline = values(before),
    candidate = values(after),
    ratio = median(candidate) / median(baseline)
  assert.ok(ratio <= 1.2, `candidate median heap ratio ${ratio} exceeds 1.20`)
  return { baseline, candidate, ratio, individualRatios: candidate.map((n, i) => n / baseline[i]) }
}
