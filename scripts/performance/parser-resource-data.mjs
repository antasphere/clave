/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript heap validation */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  const properties = (index) => {
    const fields = new Map()
    for (const e of nodes[index].edges.filter((e) => ['property', 'context'].includes(e.type))) {
      assert.ok(!fields.has(e.name), 'duplicate application field ' + e.name)
      fields.set(e.name, e.to)
    }
    return fields
  }
  const incoming = (targets) => {
    const result = new Map([...targets].map((i) => [i, []]))
    for (let from = 0; from < nodes.length; from++) {
      for (const edge of nodes[from].edges)
        if (edge.type !== 'weak' && result.has(edge.to)) result.get(edge.to).push({ from, edge })
    }
    return result
  }
  const integer = (index) => {
    const node = nodes[index]
    assert.equal(node?.type, 'number', 'typed number required')
    const links = node.edges.filter((e) => e.name === 'value')
    assert.ok(links.length === 1 && links[0].type === 'internal', 'unique internal numeric value')
    const value = nodes[links[0].to]
    assert.ok(
      value?.type === 'string' && value.edges.every((e) => e.name === 'map'),
      'decimal string required'
    )
    assert.match(value.name, /^(0|[1-9][0-9]*)$/, 'nonnegative integer decimal')
    const n = Number(value.name)
    assert.ok(Number.isSafeInteger(n) && n >= 0, 'safe finite integer required')
    return n
  }
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
  return { nodes, parent, properties, incoming, integer, text, pathTo }
}
export function inspectPrefixGraph(
  raw,
  { expectedInput, closed = false, warm, discoveryOnly = false, bindingPlanOnly = false } = {}
) {
  const g = decodeHeap(raw),
    matches = [],
    allPrefixes = [],
    contexts = [],
    exclusions = []
  const candidates = new Set()
  for (let i = 0; i < g.nodes.length; i++) {
    if (
      g.parent.has(i) &&
      g.nodes[i].type === 'object' &&
      g.nodes[i].edges.some(
        (e) =>
          e.type === 'property' &&
          e.name === 'kind' &&
          g.nodes[e.to].type === 'string' &&
          g.nodes[e.to].name === 'prefix'
      )
    )
      candidates.add(i)
  }
  const incoming = g.incoming(candidates)
  for (let i = 0; i < g.nodes.length; i++) {
    if (!candidates.has(i)) continue
    const p = g.properties(i)
    if (!p.has('kind') || !p.has('signature') || !p.has('snapshot')) continue
    if (g.nodes[p.get('kind')].type !== 'string' || g.nodes[p.get('kind')].name !== 'prefix')
      continue
    const hole = (index) =>
      g.nodes[index].type === 'hidden' && g.nodes[index].name === 'system / Hole'
    if (hole(p.get('signature')) || hole(p.get('snapshot'))) {
      const holders = incoming.get(i)
      assert.ok(
        hole(p.get('signature')) &&
          hole(p.get('snapshot')) &&
          holders.length > 0 &&
          holders.every(
            ({ from, edge }) =>
              g.nodes[from].type === 'code' &&
              ['system / AllocationSite', 'AllocationSite'].includes(g.nodes[from].name) &&
              edge.type === 'internal' &&
              edge.name === 'transition_info'
          ),
        'app-owned or malformed Hole prefix'
      )
      assert.deepEqual(
        [...p.keys()].sort(),
        ['kind', 'signature', 'snapshot', '__proto__'].filter((k) => p.has(k)).sort(),
        'boilerplate fields'
      )
      exclusions.push({
        nodeId: g.nodes[i].id,
        reason: 'code-only AllocationSite boilerplate',
        incoming: holders.map(({ from, edge }) => ({
          nodeId: g.nodes[from].id,
          type: g.nodes[from].type,
          name: g.nodes[from].name,
          edge: edge.name,
          edgeType: edge.type
        })),
        path: g.pathTo(i)
      })
      continue
    }
    if (g.text(p.get('signature')) !== 'remark-gfm4:singleTilde=true') continue
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
    const accounting = Object.fromEntries(
      [...a]
        .filter(([k]) => k !== '__proto__')
        .map(([k, v]) => {
          assert.ok(
            [
              'blocks',
              'nodes',
              'sourceSpanCodeUnits',
              'astStringCodeUnits',
              'sourceBytes'
            ].includes(k),
            'unexpected accounting field ' + k
          )
          return [k, g.integer(v)]
        })
    )
    const cut = g.integer(s.get('cut')),
      line = g.integer(s.get('line'))
    assert.equal(accounting.sourceSpanCodeUnits, cut, 'raw cut accounting')
    assert.equal(
      accounting.sourceBytes,
      2 * (cut + accounting.astStringCodeUnits),
      'raw charged UTF16 formula'
    )
    assert.ok(
      accounting.blocks <= 64 && accounting.nodes <= 4096 && accounting.sourceBytes <= 131072,
      'reported prefix caps'
    )
    const structure = recountRawAst(g, s.get('blocks'))
    assert.equal(structure.blocks, accounting.blocks, 'raw blocks recount')
    assert.equal(structure.nodes, accounting.nodes, 'raw nodes recount')
    // V8 flat display names have no completeness bit, even below 1024 characters.
    // Reconstruct representations only for diagnostics. Identity requires a live binding.
    const input = g.text(s.get('input'))
    const row = {
      nodeId: g.nodes[i].id,
      index: i,
      snapshotId: g.nodes[snapshotIndex].id,
      displayLabelMatches: input === expectedInput,
      inputIdentity: 'unbound',
      inputId: g.nodes[s.get('input')].id,
      displayCodeUnits: input.length,
      cut,
      line,
      accounting,
      structure,
      path: g.pathTo(i)
    }
    allPrefixes.push(row)
    if (row.displayLabelMatches) matches.push(row)
  }
  for (let i = 0; i < g.nodes.length; i++) {
    if (
      !g.parent.has(i) ||
      !g.nodes[i].name.includes('Context') ||
      !['snapshot', 'listeners'].every((key) =>
        g.nodes[i].edges.some((e) => ['property', 'context'].includes(e.type) && e.name === key)
      )
    )
      continue
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
      displayLabelMatches: state.displayLabelMatches,
      path: g.pathTo(i),
      closures
    })
  }
  if (!discoveryOnly && closed) {
    assert.ok(
      warm?.matches?.length > 0 && warm?.storeContexts?.length > 0,
      'prior positive warm graph required'
    )
    // All probes close. Any remaining application prefix needs concrete attribution.
    assert.equal(allPrefixes.length, 0, 'post-close live prefix requires retaining-path review')
  } else if (!discoveryOnly) {
    assert.ok(matches.length > 0, 'positive warm source-shaped match required')
    assert.ok(
      contexts.some((c) => c.displayLabelMatches),
      'positive warm store context attribution required'
    )
  }
  // Actual V8 scope names, React alternate generations and closure boundaries
  // require a separately reviewed first graph. Synthetic success is never qualification.
  return {
    qualified: false,
    reason: 'Actual V8/React retaining-path qualification required',
    ownership: planPrefixOwnership(g, allPrefixes, contexts, { bindingPlanOnly }),
    exclusions,
    matches: matches.map((row) => {
      const copy = { ...row }
      delete copy.index
      return copy
    }),
    allPrefixes: allPrefixes.map((row) => {
      const copy = { ...row }
      delete copy.index
      return copy
    }),
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

function rawArray(g, index) {
  const node = g.nodes[index]
  assert.ok(
    node.type === 'array' || (node.type === 'object' && node.name === 'Array'),
    'raw array required'
  )
  const backing = node.edges.filter((e) => e.name === 'elements')
  let edges = node.edges,
    kinds = ['element', 'property']
  if (backing.length) {
    assert.ok(
      backing.length === 1 &&
        backing[0].type === 'internal' &&
        g.nodes[backing[0].to].type === 'array',
      'unique internal array elements'
    )
    assert.ok(
      !edges.some(
        (e) => ['element', 'property'].includes(e.type) && /^(0|[1-9][0-9]*)$/.test(e.name)
      ),
      'ambiguous array representation'
    )
    edges = g.nodes[backing[0].to].edges
    kinds = ['internal']
  }
  const elements = edges
    .filter((e) => kinds.includes(e.type) && /^(0|[1-9][0-9]*)$/.test(e.name))
    .sort((a, b) => Number(a.name) - Number(b.name))
  elements.forEach((e, i) => assert.equal(e.name, String(i), 'dense raw AST array'))
  return elements.map((e) => e.to)
}
export function recountRawAst(g, index) {
  const blocks = rawArray(g, index),
    pending = [...blocks],
    seen = new Set()
  let nodes = 0
  while (pending.length) {
    const at = pending.pop()
    assert.ok(!seen.has(at), 'raw AST cycle/shared node')
    seen.add(at)
    const p = g.properties(at)
    assert.ok(p.has('type') && g.nodes[p.get('type')].type === 'string', 'raw AST type')
    for (const key of p.keys())
      assert.ok(
        [
          '__proto__',
          'type',
          'position',
          'children',
          'value',
          'url',
          'title',
          'alt',
          'depth'
        ].includes(key),
        'unexpected raw AST field ' + key
      )
    nodes++
    assert.ok(nodes <= 4096, 'raw AST node cap')
    if (p.has('children')) pending.push(...rawArray(g, p.get('children')))
  }
  return {
    blocks: blocks.length,
    nodes,
    astStringCodeUnits: null,
    reason: 'display labels cannot prove full string units'
  }
}

// Serialized by value and invoked only on the captured state handle after the raw
// checkpoint. No globals, parser calls, publication, property getters or writes.
export function readBoundPrefix(snapshot) {
  const fail = (reason) => {
    throw new Error('invalid immutable prefix binding: ' + reason)
  }
  const pointFields = ['line', 'column', 'offset'],
    positionFields = ['start', 'end'],
    nodeFields = ['type', 'position', 'children', 'value', 'url', 'title', 'alt', 'depth'],
    stringFields = ['value', 'url', 'title', 'alt']
  const data = (o, keys, array = false) => {
    if (
      !o ||
      typeof o !== 'object' ||
      (array
        ? !Array.isArray(o)
        : Object.getPrototypeOf(o) !== Object.prototype && Object.getPrototypeOf(o) !== null)
    )
      fail('plain-object')
    const descriptors = Object.getOwnPropertyDescriptors(o)
    for (const key of Reflect.ownKeys(descriptors))
      if (
        typeof key !== 'string' ||
        !Object.hasOwn(descriptors[key], 'value') ||
        (!array && !keys.includes(key))
      )
        fail('data-fields')
    if (!Object.isFrozen(o)) fail('frozen')
    return descriptors
  }
  // Optional absent fields must not read Object.prototype through the map.
  // Reuse the validated own descriptors instead of copying every value again.
  const value = (descriptors, key) =>
    Object.hasOwn(descriptors, key) ? descriptors[key].value : undefined
  const integer = (n) => {
    if (!Number.isSafeInteger(n) || n < 0) fail('integer')
    return n
  }
  const state = data(this, ['kind', 'signature', 'snapshot'])
  if (
    value(state, 'kind') !== 'prefix' ||
    value(state, 'signature') !== 'remark-gfm4:singleTilde=true' ||
    value(state, 'snapshot') !== snapshot
  )
    fail('state-identity')
  const s = data(snapshot, ['input', 'cut', 'line', 'blocks', 'rootStart', 'accounting'])
  const input = value(s, 'input')
  if (typeof input !== 'string') fail('input-type')
  const cut = integer(value(s, 'cut')),
    line = integer(value(s, 'line'))
  if (cut > input.length || line < 1) fail('cut-line')
  const point = (p) => {
    if (!p || typeof p !== 'object') fail('plain-object')
    const prototype = Object.getPrototypeOf(p)
    if (prototype !== Object.prototype && prototype !== null) fail('plain-object')
    if (Reflect.ownKeys(p).length !== 3) {
      // Preserve the generic reader's precise missing/extra-field failures.
      const d = data(p, pointFields),
        offset = integer(value(d, 'offset'))
      if (integer(value(d, 'line')) < 1 || integer(value(d, 'column')) < 1 || offset > input.length)
        fail('point')
      return offset
    }
    const line = Object.getOwnPropertyDescriptor(p, 'line'),
      column = Object.getOwnPropertyDescriptor(p, 'column'),
      offsetDescriptor = Object.getOwnPropertyDescriptor(p, 'offset')
    if (
      !line ||
      !column ||
      !offsetDescriptor ||
      !Object.hasOwn(line, 'value') ||
      !Object.hasOwn(column, 'value') ||
      !Object.hasOwn(offsetDescriptor, 'value')
    )
      fail('data-fields')
    if (!Object.isFrozen(p)) fail('frozen')
    const offset = offsetDescriptor.value,
      lineNumber = line.value,
      columnNumber = column.value
    if (!Number.isSafeInteger(offset) || offset < 0) fail('integer')
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 0) fail('integer')
    if (lineNumber < 1) fail('point')
    if (!Number.isSafeInteger(columnNumber) || columnNumber < 0) fail('integer')
    if (columnNumber < 1 || offset > input.length) fail('point')
    return offset
  }
  point(value(s, 'rootStart'))
  const array = (a) => {
    const d = data(a, [], true),
      n = integer(value(d, 'length'))
    if (n > 4096 || Object.keys(d).length !== n + 1) fail('array-shape')
    const values = []
    for (let i = 0; i < n; i++) {
      if (!Object.hasOwn(d, String(i))) fail('array-hole')
      values.push(d[i].value)
    }
    return values
  }
  const blocks = array(value(s, 'blocks')),
    pending = [...blocks],
    seen = new Set()
  let nodes = 0,
    astStringCodeUnits = 0
  while (pending.length) {
    const at = pending.pop()
    if (seen.has(at)) fail('ast-cycle')
    seen.add(at)
    const n = data(at, nodeFields),
      depth = value(n, 'depth'),
      position = value(n, 'position'),
      children = value(n, 'children')
    if (typeof value(n, 'type') !== 'string') fail('ast-type')
    if (depth !== undefined) integer(depth)
    if (position !== undefined) {
      if (!position || typeof position !== 'object') fail('plain-object')
      const prototype = Object.getPrototypeOf(position)
      if (prototype !== Object.prototype && prototype !== null) fail('plain-object')
      let start, end
      if (Reflect.ownKeys(position).length !== 2) {
        const p = data(position, positionFields)
        start = point(value(p, 'start'))
        end = point(value(p, 'end'))
      } else {
        const startDescriptor = Object.getOwnPropertyDescriptor(position, 'start'),
          endDescriptor = Object.getOwnPropertyDescriptor(position, 'end')
        if (
          !startDescriptor ||
          !endDescriptor ||
          !Object.hasOwn(startDescriptor, 'value') ||
          !Object.hasOwn(endDescriptor, 'value')
        )
          fail('data-fields')
        if (!Object.isFrozen(position)) fail('frozen')
        start = point(startDescriptor.value)
        end = point(endDescriptor.value)
      }
      if (start > end || end > cut) fail('position')
    }
    nodes++
    if (nodes > 4096) fail('node-cap')
    for (const key of stringFields) {
      const text = value(n, key)
      if (text != null && typeof text !== 'string') fail('ast-string')
      astStringCodeUnits += text?.length ?? 0
    }
    if (children !== undefined) pending.push(...array(children))
  }
  const accounting = data(value(s, 'accounting'), [
    'blocks',
    'nodes',
    'sourceSpanCodeUnits',
    'astStringCodeUnits',
    'sourceBytes'
  ])
  for (const key of Object.keys(accounting)) integer(value(accounting, key))
  const actual = {
    blocks: blocks.length,
    nodes,
    sourceSpanCodeUnits: cut,
    astStringCodeUnits,
    sourceBytes: 2 * (cut + astStringCodeUnits)
  }
  if (
    Object.keys(accounting).length !== 5 ||
    Object.entries(actual).some(([k, v]) => value(accounting, k) !== v) ||
    actual.blocks > 64 ||
    actual.nodes > 4096 ||
    actual.sourceBytes > 131072
  )
    fail('accounting-caps')
  return { input, cut, line, accounting: actual, deepFrozen: true, sameSnapshot: true }
}

// Reads actual Fiber ancestors and the HostRoot current child/sibling graph. A
// return chain alone does not establish which of a reciprocal pair is current.
export function readOwnerBatch(current, ...pairs) {
  const own = (o, k) => {
    if (!o || (typeof o !== 'object' && typeof o !== 'function')) return undefined
    const d = Object.getOwnPropertyDescriptor(o, k)
    if (d && !('value' in d)) throw new Error('owner getter refused')
    return d?.value
  }
  const whitespace = [
    '\t',
    '\n',
    '\v',
    '\f',
    '\r',
    ' ',
    '\u00a0',
    '\u1680',
    '\u2000',
    '\u2001',
    '\u2002',
    '\u2003',
    '\u2004',
    '\u2005',
    '\u2006',
    '\u2007',
    '\u2008',
    '\u2009',
    '\u200a',
    '\u2028',
    '\u2029',
    '\u202f',
    '\u205f',
    '\u3000',
    '\ufeff'
  ]
  const hasToken = (value, token) => {
    let word = ''
    for (let i = 0; i <= value.length; i++) {
      const character = value[i]
      if (i === value.length || whitespace.includes(character)) {
        if (word === token) return true
        word = ''
      } else word += character
    }
    return false
  }
  if (!pairs.length || pairs.length % 2) throw new Error('invalid owner batch shape')
  const capturedCurrent = own(this, 'current')
  if (!current || capturedCurrent !== current) throw new Error('missing HostRoot current')
  const members = [],
    requested = [],
    unique = new Set()
  for (let ordinal = 0; ordinal < pairs.length / 2; ordinal++) {
    const owner = pairs[2 * ordinal],
      expectedAlternate = pairs[2 * ordinal + 1]
    if (unique.has(owner)) throw new Error('duplicate owner batch member')
    unique.add(owner)
    requested.push(owner)
    const alternate = own(owner, 'alternate')
    if (!alternate || alternate !== expectedAlternate || own(alternate, 'alternate') !== owner)
      throw new Error('nonreciprocal Fiber alternate')
    const ancestors = [owner],
      visited = new Set()
    for (let i = 0; i < ancestors.length; i++) {
      const at = ancestors[i]
      if (visited.has(at)) throw new Error('Fiber return cycle')
      visited.add(at)
      const parent = own(at, 'return')
      if (parent) ancestors.push(parent)
    }
    const hostRoot = ancestors.at(-1),
      root = own(hostRoot, 'stateNode')
    if (own(hostRoot, 'tag') !== 3 || !own(root, 'current'))
      throw new Error('missing HostRoot current')
    if (root !== this || own(root, 'current') !== current)
      throw new Error('mixed owner batch roots')
    members.push({ owner, alternate, ancestors })
  }
  const pending = [current],
    seen = new Set()
  while (pending.length) {
    const at = pending.pop()
    if (!at || seen.has(at)) continue
    seen.add(at)
    if (seen.size > 1000000) throw new Error('Fiber traversal bound')
    if (typeof at === 'object' || typeof at === 'function') {
      const childDescriptor = Object.getOwnPropertyDescriptor(at, 'child')
      if (childDescriptor && !('value' in childDescriptor)) throw new Error('owner getter refused')
      const child = childDescriptor?.value
      const siblingDescriptor = Object.getOwnPropertyDescriptor(at, 'sibling')
      if (siblingDescriptor && !('value' in siblingDescriptor))
        throw new Error('owner getter refused')
      const sibling = siblingDescriptor?.value
      if (child) pending.push(child)
      if (sibling) pending.push(sibling)
    }
  }
  const values = []
  for (let ordinal = 0; ordinal < members.length; ordinal++) {
    const { owner, alternate, ancestors } = members[ordinal]
    const isCurrent = seen.has(owner),
      alternateCurrent = seen.has(alternate)
    if (isCurrent === alternateCurrent) throw new Error('ambiguous current/alternate reachability')
    const sessions = new Set(),
      views = new Set()
    let hostAncestorInCurrentTree = false
    for (const at of ancestors) {
      const props = own(at, 'memoizedProps')
      for (const key of ['data-session-id', 'sessionId']) {
        const v = own(props, key)
        if (typeof v === 'string') sessions.add(v)
      }
      const cls = own(props, 'className')
      if (typeof cls === 'string') {
        if (hasToken(cls, 'terminal-view')) views.add('terminal')
        else if (hasToken(cls, 'chat-view')) views.add('chat')
      }
      // DOM getters are deliberately not invoked. Connectedness requires an actual
      // root.current path plus a host ancestor in that current graph.
      if (own(at, 'tag') === 5 && seen.has(at)) hostAncestorInCurrentTree = true
    }
    values.push({
      ordinal,
      alternateOrdinal: requested.indexOf(alternate),
      branch: isCurrent ? 'current' : 'alternate',
      reciprocal: true,
      sessionIds: [...sessions],
      views: [...views],
      hostAncestorInCurrentTree,
      connected: null,
      currentReachable: true
    })
  }
  return { memberCount: members.length, sameRoot: true, members: values }
}

// A snapshot plan is a hint only. The reader confirms the full terminal chain
// against these separately captured anchors. Unsupported graphs retain all rows.
export function planOwnerBatch(g, fibers) {
  try {
    const ids = new Map(g.nodes.map((node, index) => [node.id, index]))
    const unique = new Set(),
      groups = []
    const property = (index, key) => {
      const edges = g.nodes[index]?.edges.filter((e) => e.type === 'property' && e.name === key)
      assert.equal(edges?.length, 1, 'represented strong property required')
      const to = edges[0].to
      assert.ok(g.parent.has(to), 'strongly reachable anchor required')
      return to
    }
    for (const [rowIndex, row] of fibers.entries()) {
      assert.ok(Number.isSafeInteger(row.fiberId) && row.fiberId >= 0)
      assert.ok(Number.isSafeInteger(row.alternateId) && row.alternateId >= 0)
      assert.ok(!unique.has(row.fiberId), 'unique owner rows required')
      unique.add(row.fiberId)
      const index = ids.get(row.fiberId),
        alternate = ids.get(row.alternateId)
      assert.ok(index !== undefined && alternate !== undefined)
      assert.equal(property(index, 'alternate'), alternate)
      assert.equal(property(alternate, 'alternate'), index)
      const visited = new Set()
      let at = index,
        hintRoot
      while (true) {
        assert.ok(!visited.has(at), 'owner return cycle')
        visited.add(at)
        if (g.integer(property(at, 'tag')) === 3 && hintRoot === undefined) hintRoot = at
        const links = g.nodes[at].edges.filter((e) => e.name === 'return')
        if (!links.length) {
          assert.ok(hintRoot !== undefined)
          break
        }
        const next = property(at, 'return')
        // A non-object end is only a discovery boundary, never runtime proof.
        if (g.nodes[next].type !== 'object') {
          assert.ok(hintRoot !== undefined)
          break
        }
        at = next
      }
      const root = property(hintRoot, 'stateNode'),
        current = property(root, 'current')
      assert.equal(g.nodes[root].type, 'object')
      assert.equal(g.nodes[current].type, 'object')
      assert.equal(g.integer(property(current, 'tag')), 3)
      const rootStateId = g.nodes[root].id,
        currentId = g.nodes[current].id
      assert.ok(Number.isSafeInteger(rootStateId) && rootStateId >= 0)
      assert.ok(Number.isSafeInteger(currentId) && currentId >= 0)
      let group = groups.find((x) => x.rootStateId === rootStateId && x.currentId === currentId)
      if (!group) {
        group = { rootStateId, currentId, rowIndexes: [] }
        groups.push(group)
      }
      group.rowIndexes.push(rowIndex)
    }
    if (groups.length > 1)
      return {
        supported: false,
        groups,
        reason: 'multiple owner roots require representation review'
      }
    return { supported: true, groups }
  } catch {
    return {
      supported: false,
      groups: [],
      reason: 'owner root anchors are not completely represented'
    }
  }
}

function checkedOwnerGroup(fibers, plan) {
  assert.ok(plan?.supported === true && Array.isArray(plan.groups), 'supported owner plan required')
  if (!fibers.length) {
    assert.equal(plan.groups.length, 0)
    return undefined
  }
  assert.equal(plan.groups.length, 1, 'one root group required')
  const group = plan.groups[0]
  for (const key of ['rootStateId', 'currentId']) assert.ok(safeInteger(group[key]))
  assert.deepEqual(
    group.rowIndexes,
    fibers.map((_, i) => i),
    'complete ordered owner membership'
  )
  const unique = new Set()
  for (const row of fibers) {
    assert.ok(safeInteger(row.fiberId) && safeInteger(row.alternateId))
    assert.ok(!unique.has(row.fiberId), 'unique owner identity required')
    unique.add(row.fiberId)
    const other = fibers.find((x) => x.fiberId === row.alternateId)
    if (other) assert.equal(other.alternateId, row.fiberId)
  }
  return group
}

function mappedOwnerBatch(fibers, value) {
  assert.deepEqual(Object.keys(value).sort(), ['memberCount', 'members', 'sameRoot'])
  assert.equal(value.sameRoot, true)
  assert.equal(value.memberCount, fibers.length)
  const dense = (array, length) => {
    assert.ok(Array.isArray(array))
    assert.equal(array.length, length)
    assert.equal(Object.keys(array).length, length)
    for (let i = 0; i < length; i++) assert.ok(Object.hasOwn(array, i))
  }
  dense(value.members, fibers.length)
  const result = value.members.map((member, ordinal) => {
    assert.deepEqual(Object.keys(member).sort(), [
      'alternateOrdinal',
      'branch',
      'connected',
      'currentReachable',
      'hostAncestorInCurrentTree',
      'ordinal',
      'reciprocal',
      'sessionIds',
      'views'
    ])
    assert.equal(member.ordinal, ordinal)
    assert.equal(
      member.alternateOrdinal,
      fibers.findIndex((x) => x.fiberId === fibers[ordinal].alternateId)
    )
    assert.ok(['current', 'alternate'].includes(member.branch))
    assert.equal(member.reciprocal, true)
    assert.equal(member.currentReachable, true)
    assert.equal(member.connected, null)
    assert.equal(typeof member.hostAncestorInCurrentTree, 'boolean')
    for (const key of ['sessionIds', 'views']) {
      dense(member[key], member[key].length)
      assert.equal(new Set(member[key]).size, member[key].length)
      assert.ok(member[key].every((x) => typeof x === 'string'))
    }
    assert.ok(member.views.every((x) => x === 'terminal' || x === 'chat'))
    const { ordinal: index, alternateOrdinal: unused, ...metadata } = member
    void unused
    return { ...fibers[index], ...metadata }
  })
  for (let i = 0; i < fibers.length; i++) {
    const alternate = fibers.findIndex((x) => x.fiberId === fibers[i].alternateId)
    if (alternate >= 0) assert.notEqual(result[i].branch, result[alternate].branch)
  }
  return result
}

export function planPrefixOwnership(g, states, storeContexts, { bindingPlanOnly = false } = {}) {
  const stateIndexes = new Map(
    states.map((s) => [g.nodes.findIndex((n) => n.id === s.nodeId), s.nodeId])
  )
  const holders = g.incoming(new Set(stateIndexes.keys())),
    fibers = [],
    recognized = new Set()
  // Exactly the slots from MarkdownMessage: first useState owns the store;
  // next useSyncExternalStore hook owns memoizedState and queue.value. Each
  // actual reciprocal Fiber contributes at most those slots, not N generations.
  for (let i = 0; i < g.nodes.length; i++) {
    if (!g.parent.has(i) || g.nodes[i].name !== 'FiberNode') continue
    const fp = g.properties(i),
      alt = fp.get('alternate')
    if (
      alt === undefined ||
      g.nodes[alt].name !== 'FiberNode' ||
      g.properties(alt).get('alternate') !== i
    )
      continue
    const first = fp.get('memoizedState')
    if (first === undefined) continue
    const hook = g.properties(first).get('next')
    if (hook === undefined) continue
    const hp = g.properties(hook),
      queue = hp.get('queue'),
      store = g.properties(first).get('memoizedState')
    const context =
      store === undefined
        ? undefined
        : storeContexts.find((c) => {
            const get = g.properties(store).get('getSnapshot')
            return get !== undefined && c.closures.some((x) => x.nodeId === g.nodes[get].id)
          })
    if (!context) continue
    const slots = []
    for (const [from, key] of [
      [hook, 'memoizedState'],
      [queue, 'value']
    ]) {
      if (from === undefined) continue
      const state = g.properties(from).get(key)
      if (stateIndexes.has(state)) {
        slots.push({ stateId: stateIndexes.get(state), holderId: g.nodes[from].id, key })
        recognized.add(`${from}:${key}:${state}`)
      }
    }
    if (slots.length)
      fibers.push({
        fiberId: g.nodes[i].id,
        alternateId: g.nodes[alt].id,
        storeContextId: context.nodeId,
        slots,
        requiresLiveOwner: true
      })
  }
  if (bindingPlanOnly)
    return {
      qualified: false,
      fibers,
      ownerBatchPlan: planOwnerBatch(g, fibers),
      reason:
        'preliminary handle plan only; full retaining-path analysis deferred until both raw checkpoints persist'
    }
  const unresolved = []
  for (const [to, refs] of holders)
    for (const { from, edge } of refs) {
      const store = storeContexts.some(
        (c) => c.nodeId === g.nodes[from].id && edge.type === 'context' && edge.name === 'snapshot'
      )
      if (!store && !recognized.has(`${from}:${edge.name}:${to}`))
        unresolved.push({
          stateId: stateIndexes.get(to),
          holderId: g.nodes[from].id,
          type: g.nodes[from].type,
          name: g.nodes[from].name,
          edge: edge.name,
          edgeType: edge.type,
          reason: 'unrecognized hook/attempt/processor/history ownership'
        })
    }
  const inputIndexes = new Set(states.map((s) => g.nodes.findIndex((n) => n.id === s.inputId)))
  const inputHolders = [...g.incoming(inputIndexes)].flatMap(([to, refs]) =>
    refs.map(({ from, edge }) => ({
      inputId: g.nodes[to].id,
      holderId: g.nodes[from].id,
      type: g.nodes[from].type,
      name: g.nodes[from].type === 'string' ? '[string]' : g.nodes[from].name.slice(0, 160),
      edge: edge.name,
      edgeType: edge.type,
      attribution: 'pending'
    }))
  )
  return {
    qualified: false,
    inputHolders,
    fibers,
    ownerBatchPlan: planOwnerBatch(g, fibers),
    unresolved,
    reason:
      'attempt closures, all input holders and current store publication require complete actual attribution; lexical Context.previous is not an application history slot'
  }
}

// No returned full body survives in the persisted receipt. UTF16LE SHA256 hashes
// every JS code unit, including unpaired surrogates, without UTF8 substitution.
export function summarizeBoundPrefix(value, row, expectedInputs) {
  assert.ok(value && typeof value.input === 'string', 'full binding input required')
  try {
    const version = expectedInputs.findIndex((s) => typeof s === 'string' && s === value.input)
    if (version < 0) {
      const error = new Error('binding input is not an exact declared canonical version')
      error.name = 'QualificationSemanticError'
      throw error
    }
    assert.equal(value.sameSnapshot, true)
    assert.equal(value.deepFrozen, true)
    assert.equal(value.cut, row.cut)
    assert.equal(value.line, row.line)
    assert.deepEqual(value.accounting, row.accounting)
    assert.equal(value.accounting.blocks, row.structure.blocks)
    assert.equal(value.accounting.nodes, row.structure.nodes)
    return {
      stateId: row.nodeId,
      snapshotId: row.snapshotId,
      inputId: row.inputId,
      inputCodeUnits: value.input.length,
      inputSha256: createHash('sha256').update(Buffer.from(value.input, 'utf16le')).digest('hex'),
      encoding: 'utf16le',
      canonicalVersion: version,
      exactCanonical: true,
      cut: value.cut,
      line: value.line,
      accounting: value.accounting,
      deepFrozen: true
    }
  } catch (error) {
    error.name = 'QualificationSemanticError'
    throw error
  } finally {
    delete value.input
  }
}

const INVARIANT_REASONS = [
  'plain-object',
  'data-fields',
  'frozen',
  'integer',
  'state-identity',
  'input-type',
  'cut-line',
  'point',
  'array-shape',
  'array-hole',
  'ast-cycle',
  'ast-type',
  'position',
  'node-cap',
  'ast-string',
  'accounting-caps'
]
const BINDING_STAGES = [
  'graph-plan',
  'before-binding-usage',
  'prefix-state-handle',
  'prefix-snapshot-handle',
  'prefix-state-read',
  'prefix-serialization',
  'owner-fiber-handle',
  'owner-fiber-read',
  'owner-root-handle',
  'owner-current-handle',
  'owner-alternate-handle',
  'owner-batch-read',
  'owner-batch-validation',
  'release-group',
  'invalidate-handle',
  'after-binding-usage',
  'session-detach'
]
const safeInteger = (n) => Number.isSafeInteger(n) && n >= 0
const ownData = (o, k) => {
  if (!o || typeof o !== 'object') return undefined
  const d = Object.getOwnPropertyDescriptor(o, k)
  return d && 'value' in d ? d.value : undefined
}
// Protocol responses are untrusted diagnostic data. Keep a small field whitelist
// and only known tool/engine message literals; unknown text is explicitly redacted.
export function sanitizeExceptionDetails(details) {
  const result = {}
  const pickNumber = (source, key, target) => {
    const value = ownData(source, key)
    if (safeInteger(value)) target[key] = value
  }
  const text = ownData(details, 'text')
  if (typeof text === 'string')
    result.text = ['Uncaught', 'Uncaught (in promise)'].includes(text) ? text : '[redacted]'
  pickNumber(details, 'lineNumber', result)
  pickNumber(details, 'columnNumber', result)
  const exception = ownData(details, 'exception')
  if (exception && typeof exception === 'object') {
    result.exception = {}
    for (const [key, allowed] of [
      [
        'type',
        ['object', 'function', 'undefined', 'string', 'number', 'boolean', 'symbol', 'bigint']
      ],
      ['subtype', ['error', 'null']],
      [
        'className',
        [
          'Error',
          'EvalError',
          'TypeError',
          'RangeError',
          'ReferenceError',
          'SyntaxError',
          'URIError',
          'AggregateError',
          'InternalError'
        ]
      ]
    ]) {
      const value = ownData(exception, key)
      if (typeof value === 'string')
        result.exception[key] = allowed.includes(value) ? value.slice(0, 200) : '[redacted]'
    }
    const description = ownData(exception, 'description')
    if (typeof description === 'string') {
      const first = description.split(/\r?\n/, 1)[0]
      const ownerReasons = [
        'owner getter refused',
        'nonreciprocal Fiber alternate',
        'Fiber return cycle',
        'missing HostRoot current',
        'Fiber traversal bound',
        'ambiguous current/alternate reachability',
        'invalid owner batch shape',
        'duplicate owner batch member',
        'mixed owner batch roots'
      ]
      const invariants = [
        ...ownerReasons.map((reason) => 'Error: ' + reason),
        'Error: invalid immutable prefix binding',
        ...INVARIANT_REASONS.map((reason) => 'Error: invalid immutable prefix binding: ' + reason)
      ]
      result.exception.description =
        first === 'EvalError: Possible side-effect in debug-evaluate' || invariants.includes(first)
          ? first.slice(0, 200)
          : '[redacted remote description]'
    }
  }
  const stack = ownData(details, 'stackTrace'),
    frames = ownData(stack, 'callFrames')
  if (Array.isArray(frames))
    result.stackTrace = {
      callFrames: frames.slice(0, 10).map((frame) => {
        const row = {},
          name = ownData(frame, 'functionName')
        if (typeof name === 'string')
          row.functionName = [
            '',
            'readBoundPrefix',
            'readOwnerBatch',
            'data',
            'fail',
            'integer',
            'point',
            'array',
            'own',
            'post',
            'Session.post',
            'call'
          ].includes(name)
            ? name.slice(0, 200)
            : '[redacted]'
        pickNumber(frame, 'lineNumber', row)
        pickNumber(frame, 'columnNumber', row)
        return row
      })
    }
  return result
}
function bindingContext(context) {
  const result = {
    phase: ['binding', 'warm', 'final-closed'].includes(context.phase) ? context.phase : 'binding',
    stage: BINDING_STAGES.includes(context.stage) ? context.stage : 'graph-plan'
  }
  for (const key of [
    'rowIndex',
    'stateId',
    'snapshotId',
    'fiberId',
    'batchIndex',
    'memberCount',
    'rootStateId',
    'currentId',
    'alternateId'
  ])
    if (safeInteger(context[key])) result[key] = context[key]
  return result
}
function bindingUsage(value) {
  const result = {}
  for (const key of ['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize']) {
    if (Object.hasOwn(value ?? {}, key)) {
      assert.ok(finite(value[key]), 'finite binding diagnostic usage required')
      result[key] = value[key]
    }
  }
  assert.ok(
    Object.hasOwn(result, 'usedSize') &&
      Object.hasOwn(result, 'totalSize') &&
      result.totalSize >= result.usedSize,
    'binding diagnostic usage shape'
  )
  return result
}
export async function bindCapturedGraph(
  cdp,
  graph,
  expectedInputs,
  { objectGroup = 'parser-resource-binding', timeoutMs = 10000, phase = 'binding' } = {}
) {
  const handles = [],
    states = [],
    owners = [],
    failures = [],
    methods = [],
    createdErrors = new WeakSet()
  const diagnosticUsage = {
    outsideMeasuredCheckpoint: true,
    noGC: true,
    noAcceptance: true,
    before: null,
    after: null,
    deltas: null
  }
  let operationError,
    cleanupError,
    timedOut = false,
    invalidatedHandles = 0,
    released = false
  const errorFor = (toolMessage, context, protocol, kind = 'binding') => {
    const error = new Error(toolMessage)
    error.bindingFailure = {
      ...bindingContext({ ...context, phase }),
      kind,
      toolMessage,
      ...(protocol ? { protocol: sanitizeExceptionDetails(protocol) } : {})
    }
    createdErrors.add(error)
    failures.push(error.bindingFailure)
    return error
  }
  const send = async (method, params, context) => {
    methods.push({
      method,
      ...bindingContext({ ...context, phase }),
      parameterKeys: Object.keys(params ?? {}).sort()
    })
    let timer
    try {
      return await Promise.race([
        cdp.send(method, params),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            reject(errorFor('binding command timeout ' + method, context, undefined, 'timeout'))
          }, timeoutMs)
        })
      ])
    } catch (error) {
      if (createdErrors.has(error)) throw error
      const expectedMissing =
        context.stage === 'invalidate-handle' &&
        /(?:^|: )(?:Could not find object with given id|Cannot find object with id)$/.test(
          String(error)
        )
      if (expectedMissing) {
        const missing = new Error('released binding handle not found')
        missing.bindingObjectNotFound = true
        throw missing
      }
      throw errorFor('binding command transport failed', context, undefined, 'transport')
    } finally {
      clearTimeout(timer)
    }
  }
  const remember = (id) => {
    if (typeof id === 'string' && id && !handles.includes(id)) handles.push(id)
  }
  const handle = async (id, context) => {
    const r = await send(
      'HeapProfiler.getObjectByHeapObjectId',
      { objectId: String(id), objectGroup },
      context
    )
    if (!r.result?.objectId)
      throw errorFor('captured heap id did not resolve', context, undefined, 'acquisition')
    remember(r.result.objectId)
    return r.result.objectId
  }
  const read = async (objectId, fn, args, context) => {
    const r = await send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: fn.toString(),
        arguments: args,
        returnByValue: true,
        silent: true,
        throwOnSideEffect: true,
        objectGroup
      },
      context
    )
    remember(r.result?.objectId)
    remember(ownData(ownData(r.exceptionDetails, 'exception'), 'objectId'))
    if (r.exceptionDetails) {
      const error = errorFor(
        'read-only binding exception',
        context,
        r.exceptionDetails,
        'returned-exception'
      )
      const description = ownData(ownData(r.exceptionDetails, 'exception'), 'description')
      if (
        typeof description === 'string' &&
        description.startsWith('Error: invalid immutable prefix binding')
      )
        error.name = 'QualificationSemanticError'
      throw error
    }
    if (!Object.hasOwn(r.result ?? {}, 'value'))
      throw errorFor('primitive binding result required', context, undefined, 'serialization')
    return r.result.value
  }
  const usage = async (stage) => {
    const value = await send('Runtime.getHeapUsage', {}, { stage })
    try {
      return bindingUsage(value)
    } catch {
      throw errorFor('binding diagnostic usage invalid', { stage }, undefined, 'diagnostic-usage')
    }
  }
  const release = async () => {
    await send('Runtime.releaseObjectGroup', { objectGroup }, { stage: 'release-group' })
    released = true
    for (let rowIndex = 0; rowIndex < handles.length; rowIndex++) {
      let invalid = false
      try {
        await send(
          'Runtime.callFunctionOn',
          {
            objectId: handles[rowIndex],
            functionDeclaration: 'function(){return 1}',
            returnByValue: true,
            silent: true,
            throwOnSideEffect: true
          },
          { stage: 'invalidate-handle', rowIndex }
        )
      } catch (error) {
        if (error.bindingObjectNotFound) invalid = true
        else throw error
      }
      if (!invalid)
        throw errorFor(
          'released handle remained usable',
          { stage: 'invalidate-handle', rowIndex },
          undefined,
          'cleanup'
        )
      invalidatedHandles++
    }
  }
  let ownerGroup,
    pendingOwners = []
  const ownerBatchPlan =
    graph.ownership.ownerBatchPlan ??
    (graph.ownership.fibers.length === 0 ? { supported: true, groups: [] } : undefined)
  try {
    try {
      ownerGroup = checkedOwnerGroup(graph.ownership.fibers, ownerBatchPlan)
    } catch {
      throw errorFor(
        'unsupported owner batch plan',
        { stage: 'graph-plan' },
        undefined,
        'representation'
      )
    }
    diagnosticUsage.before = await usage('before-binding-usage')
    for (const [rowIndex, row] of graph.allPrefixes.entries()) {
      const context = { rowIndex, stateId: row.nodeId, snapshotId: row.snapshotId }
      const state = await handle(row.nodeId, { ...context, stage: 'prefix-state-handle' }),
        snapshot = await handle(row.snapshotId, { ...context, stage: 'prefix-snapshot-handle' })
      const value = await read(state, readBoundPrefix, [{ objectId: snapshot }], {
        ...context,
        stage: 'prefix-state-read'
      })
      try {
        states.push(summarizeBoundPrefix(value, row, expectedInputs))
      } catch (error) {
        const failure = errorFor(
          error.message === 'binding input is not an exact declared canonical version'
            ? error.message
            : 'binding semantic validation failed',
          { ...context, stage: 'prefix-serialization' },
          undefined,
          'semantic'
        )
        failure.name = 'QualificationSemanticError'
        throw failure
      }
    }
    if (ownerGroup) {
      const context = {
        batchIndex: 0,
        memberCount: graph.ownership.fibers.length,
        rootStateId: ownerGroup.rootStateId,
        currentId: ownerGroup.currentId
      }
      const cache = new Map()
      const ownerHandle = async (id, details) => {
        if (!cache.has(id)) cache.set(id, await handle(id, details))
        return cache.get(id)
      }
      const root = await ownerHandle(ownerGroup.rootStateId, {
        ...context,
        stage: 'owner-root-handle'
      })
      const current = await ownerHandle(ownerGroup.currentId, {
        ...context,
        stage: 'owner-current-handle'
      })
      const args = [{ objectId: current }]
      for (const [rowIndex, row] of graph.ownership.fibers.entries()) {
        args.push({
          objectId: await ownerHandle(row.fiberId, {
            ...context,
            rowIndex,
            fiberId: row.fiberId,
            stage: 'owner-fiber-handle'
          })
        })
        args.push({
          objectId: await ownerHandle(row.alternateId, {
            ...context,
            rowIndex,
            alternateId: row.alternateId,
            stage: 'owner-alternate-handle'
          })
        })
      }
      const value = await read(root, readOwnerBatch, args, {
        ...context,
        stage: 'owner-batch-read'
      })
      let mapped
      try {
        mapped = mappedOwnerBatch(graph.ownership.fibers, value)
      } catch {
        const failure = errorFor(
          'owner batch semantic validation failed',
          { ...context, stage: 'owner-batch-validation' },
          undefined,
          'semantic'
        )
        failure.name = 'QualificationSemanticError'
        throw failure
      }
      pendingOwners = mapped
    }
  } catch (error) {
    operationError = error
  } finally {
    try {
      await release()
    } catch (error) {
      cleanupError = error
    }
    try {
      diagnosticUsage.after = await usage('after-binding-usage')
    } catch (error) {
      operationError ??= error
    }
  }
  if (diagnosticUsage.before && diagnosticUsage.after)
    diagnosticUsage.deltas = Object.fromEntries(
      Object.keys(diagnosticUsage.before)
        .filter((key) => Object.hasOwn(diagnosticUsage.after, key))
        .map((key) => [key, diagnosticUsage.after[key] - diagnosticUsage.before[key]])
    )
  diagnosticUsage.callCount = methods.length
  diagnosticUsage.methodCounts = Object.fromEntries(
    [...new Set(methods.map((x) => x.method))].map((method) => [
      method,
      methods.filter((x) => x.method === method).length
    ])
  )
  diagnosticUsage.methods = methods
  const receipt = {
    qualified: false,
    states,
    owners,
    ownerBatchPlan,
    released,
    invalidatedHandles,
    diagnosticUsage,
    failures
  }
  if (cleanupError || timedOut) {
    const error = new AggregateError(
      [operationError, cleanupError].filter(Boolean),
      'binding cleanup failed or timeout; stop before lifecycle/GC'
    )
    error.bindingFailure = cleanupError?.bindingFailure ?? operationError?.bindingFailure
    error.bindingReceipt = receipt
    throw error
  }
  if (operationError) {
    operationError.bindingReceipt = receipt
    throw operationError
  }
  owners.push(...pendingOwners)
  return {
    ...receipt,
    reason: 'actual graph owner/input/processor attribution and later runtime review still required'
  }
}

export async function captureQualificationPair({ capture, bind, close, analyze }) {
  const observations = [],
    failures = []
  for (const milestone of ['warm', 'final-closed']) {
    if (milestone === 'final-closed') await close()
    const entry = await capture(milestone)
    observations.push(entry)
    try {
      entry.binding = await bind(entry)
    } catch (e) {
      if (e.bindingReceipt) entry.bindingPartial = e.bindingReceipt
      entry.bindingFailure = {
        name:
          e.name === 'QualificationSemanticError'
            ? e.name
            : e instanceof AggregateError
              ? 'AggregateError'
              : 'Error',
        message: 'post-snapshot representation/binding failed',
        ...e.bindingFailure
      }
      failures.push({ milestone, error: e })
      if (e instanceof AggregateError || e.name === 'QualificationSemanticError') throw e // uncertain cleanup or semantic invalidity stops lifecycle
    }
  }
  for (const entry of observations) {
    try {
      entry.graph = await analyze(entry)
    } catch (e) {
      entry.analysisFailure = { name: e.name, message: 'offline graph analysis failed' }
      failures.push({ milestone: entry.milestone, error: e })
    }
  }
  return {
    qualified: false,
    observations,
    failures: failures.map(({ milestone, error }) => ({
      milestone,
      name: error.name,
      message: error.bindingFailure?.toolMessage ?? 'post-snapshot binding/analysis failed',
      ...error.bindingFailure
    })),
    completedRawPair: true
  }
}

export async function captureHeapCheckpoint(cdp, { persistUsage, beginSnapshot, finishSnapshot }) {
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'parser-resource-binding' })
  for (let i = 0; i < RESOURCE_CONFIG.gcPasses; i++) await cdp.send('HeapProfiler.collectGarbage')
  const usage = await cdp.send('Runtime.getHeapUsage')
  assert.ok(
    Number.isFinite(usage.usedSize) &&
      usage.usedSize > 0 &&
      Number.isFinite(usage.totalSize) &&
      usage.totalSize >= usage.usedSize,
    'actual GC heap metric'
  )
  const entry = await persistUsage(usage)
  await beginSnapshot(entry)
  await cdp.send('HeapProfiler.takeHeapSnapshot', {
    reportProgress: false,
    captureNumericValue: true,
    exposeInternals: true
  })
  await finishSnapshot(entry)
  return entry
}
