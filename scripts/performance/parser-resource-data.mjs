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
    if (
      Reflect.ownKeys(descriptors).some(
        (k) =>
          typeof k !== 'string' || !('value' in descriptors[k]) || (!array && !keys.includes(k))
      )
    )
      fail('data-fields')
    if (!Object.isFrozen(o)) fail('frozen')
    const copy = Object.create(null)
    for (const [key, descriptor] of Object.entries(descriptors)) copy[key] = descriptor.value
    return copy
  }
  const integer = (n) => {
    if (!Number.isSafeInteger(n) || n < 0) fail('integer')
    return n
  }
  const state = data(this, ['kind', 'signature', 'snapshot'])
  if (
    state.kind !== 'prefix' ||
    state.signature !== 'remark-gfm4:singleTilde=true' ||
    state.snapshot !== snapshot
  )
    fail('state-identity')
  const s = data(snapshot, ['input', 'cut', 'line', 'blocks', 'rootStart', 'accounting'])
  if (typeof s.input !== 'string') fail('input-type')
  const cut = integer(s.cut),
    line = integer(s.line)
  if (cut > s.input.length || line < 1) fail('cut-line')
  const point = (p) => {
    const d = data(p, ['line', 'column', 'offset'])
    if (integer(d.line) < 1 || integer(d.column) < 1 || integer(d.offset) > s.input.length)
      fail('point')
    return d
  }
  point(s.rootStart)
  const array = (a) => {
    const d = data(a, [], true),
      n = integer(d.length)
    if (n > 4096 || Object.keys(d).length !== n + 1) fail('array-shape')
    const values = []
    for (let i = 0; i < n; i++) {
      if (!Object.hasOwn(d, String(i))) fail('array-hole')
      values.push(d[i])
    }
    return values
  }
  const blocks = array(s.blocks),
    pending = [...blocks],
    seen = new Set()
  let nodes = 0,
    astStringCodeUnits = 0
  while (pending.length) {
    const at = pending.pop()
    if (seen.has(at)) fail('ast-cycle')
    seen.add(at)
    const n = data(at, ['type', 'position', 'children', 'value', 'url', 'title', 'alt', 'depth'])
    if (typeof n.type !== 'string') fail('ast-type')
    if (n.depth !== undefined) integer(n.depth)
    if (n.position !== undefined) {
      const p = data(n.position, ['start', 'end']),
        start = point(p.start),
        end = point(p.end)
      if (start.offset > end.offset || end.offset > cut) fail('position')
    }
    nodes++
    if (nodes > 4096) fail('node-cap')
    for (const key of ['value', 'url', 'title', 'alt']) {
      if (n[key] != null && typeof n[key] !== 'string') fail('ast-string')
      astStringCodeUnits += n[key]?.length ?? 0
    }
    if (n.children !== undefined) pending.push(...array(n.children))
  }
  const accounting = data(s.accounting, [
    'blocks',
    'nodes',
    'sourceSpanCodeUnits',
    'astStringCodeUnits',
    'sourceBytes'
  ])
  for (const n of Object.values(accounting)) integer(n)
  const actual = {
    blocks: blocks.length,
    nodes,
    sourceSpanCodeUnits: cut,
    astStringCodeUnits,
    sourceBytes: 2 * (cut + astStringCodeUnits)
  }
  if (
    Object.keys(accounting).length !== 5 ||
    Object.entries(actual).some(([k, v]) => accounting[k] !== v) ||
    actual.blocks > 64 ||
    actual.nodes > 4096 ||
    actual.sourceBytes > 131072
  )
    fail('accounting-caps')
  return { input: s.input, cut, line, accounting: actual, deepFrozen: true, sameSnapshot: true }
}

// Reads actual Fiber ancestors and the HostRoot current child/sibling graph. A
// return chain alone does not establish which of a reciprocal pair is current.
export function readOwnerFiber() {
  const own = (o, k) => {
    if (!o || (typeof o !== 'object' && typeof o !== 'function')) return undefined
    const d = Object.getOwnPropertyDescriptor(o, k)
    if (d && !('value' in d)) throw new Error('owner getter refused')
    return d?.value
  }
  const hasToken = (value, token) => {
    let word = ''
    for (let i = 0; i <= value.length; i++) {
      const character = value[i]
      if (
        i === value.length ||
        [
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
        ].includes(character)
      ) {
        if (word === token) return true
        word = ''
      } else word += character
    }
    return false
  }
  const alternate = own(this, 'alternate')
  if (!alternate || own(alternate, 'alternate') !== this)
    throw new Error('nonreciprocal Fiber alternate')
  const ancestors = [this],
    visited = new Set()
  for (let i = 0; i < ancestors.length; i++) {
    const at = ancestors[i]
    if (visited.has(at)) throw new Error('Fiber return cycle')
    visited.add(at)
    const parent = own(at, 'return')
    if (parent) ancestors.push(parent)
  }
  const hostRoot = ancestors.at(-1),
    root = own(hostRoot, 'stateNode'),
    current = own(root, 'current')
  if (own(hostRoot, 'tag') !== 3 || !current) throw new Error('missing HostRoot current')
  const pending = [current],
    seen = new Set()
  let isCurrent = false,
    alternateCurrent = false
  while (pending.length) {
    const at = pending.pop()
    if (!at || seen.has(at)) continue
    seen.add(at)
    if (seen.size > 1000000) throw new Error('Fiber traversal bound')
    if (at === this) isCurrent = true
    if (at === alternate) alternateCurrent = true
    pending.push(own(at, 'child'), own(at, 'sibling'))
  }
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
  return {
    branch: isCurrent ? 'current' : 'alternate',
    reciprocal: true,
    sessionIds: [...sessions],
    views: [...views],
    hostAncestorInCurrentTree,
    connected: null,
    currentReachable: true
  }
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
      const invariants = [
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
            'readOwnerFiber',
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
  for (const key of ['rowIndex', 'stateId', 'snapshotId', 'fiberId'])
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
  try {
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
    for (const [rowIndex, owner] of graph.ownership.fibers.entries()) {
      const context = { rowIndex, fiberId: owner.fiberId }
      const objectId = await handle(owner.fiberId, { ...context, stage: 'owner-fiber-handle' })
      owners.push({
        ...owner,
        ...(await read(objectId, readOwnerFiber, [], { ...context, stage: 'owner-fiber-read' }))
      })
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
