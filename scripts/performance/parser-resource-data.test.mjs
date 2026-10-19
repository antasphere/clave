/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript heap graph fixtures */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  decodeHeap,
  readBoundPrefix,
  readOwnerFiber,
  summarizeBoundPrefix,
  bindCapturedGraph,
  captureQualificationPair,
  captureHeapCheckpoint,
  inspectPrefixGraph,
  checkResourceComparison,
  RESOURCE_CONFIG
} from './parser-resource-data.mjs'
// Small V8-format graph, not a renderer heap. Offsets and type enums are real schema fields.
function heap({
  closed = false,
  history = false,
  weak = false,
  missingContext = false,
  internalContext = true
} = {}) {
  const strings = [
    '',
    'root',
    'object',
    'prefix',
    'kind',
    'signature',
    'remark-gfm4:singleTilde=true',
    'snapshot',
    'input',
    'synthetic-current',
    'blocks',
    'accounting',
    'nodes',
    'sourceBytes',
    'sourceSpanCodeUnits',
    'astStringCodeUnits',
    'cut',
    'line',
    'rootStart',
    'snapshot-context',
    'system / Context',
    'getSnapshot',
    'context',
    'listeners',
    'Set',
    'publish',
    'history',
    'previous'
  ]
  const specs = [
    ['synthetic', 'root', []],
    ['object', 'object', []],
    ['string', 'prefix', []],
    ['string', 'remark-gfm4:singleTilde=true', []],
    ['object', 'object', []],
    ['string', 'synthetic-current', []],
    ['array', 'object', []],
    ['object', 'object', []],
    ['hidden', 'system / Context', []],
    ['closure', 'getSnapshot', []],
    ['object', 'Set', []],
    ['closure', 'publish', []],
    ['number', '2', []],
    ['number', '8', []],
    ['number', '1', []],
    ['object', 'object', []]
  ]
  const s = (x) => {
    let i = strings.indexOf(x)
    if (i < 0) {
      i = strings.length
      strings.push(x)
    }
    return i
  }
  const edge = (from, type, name, to) =>
    specs[from][2].push([type, type === 1 ? Number(name) : s(name), to * 6])
  if (missingContext && !weak) edge(0, 0, 'unattributed-state', 1)
  if (!closed) {
    edge(0, weak ? 3 : 0, 'store', 9)
    edge(9, internalContext ? 4 : 0, 'context', 8)
    edge(11, internalContext ? 4 : 0, 'context', 8)
    edge(0, 0, 'publisher', 11)
    if (!missingContext) edge(8, 2, 'snapshot', 1)
    edge(8, 2, 'listeners', 10)
  }
  for (const [name, to] of [
    ['kind', 2],
    ['signature', 3],
    ['snapshot', 4]
  ])
    edge(1, 0, name, to)
  for (const [name, to] of [
    ['input', 5],
    ['blocks', 6],
    ['accounting', 7],
    ['cut', 12],
    ['line', 14],
    ['rootStart', 15]
  ])
    edge(4, 0, name, to)
  for (const [name, to] of [
    ['nodes', 12],
    ['sourceBytes', 13],
    ['sourceSpanCodeUnits', 12],
    ['astStringCodeUnits', 12],
    ['blocks', 14]
  ])
    edge(7, 0, name, to)
  // Actual captured V8 numbers are number -> internal value -> decimal string.
  for (const i of [12, 13, 14]) {
    const n = specs.length
    specs.push(['string', specs[i][1], []])
    specs[i][1] = 'smi number'
    edge(i, 4, 'value', n)
  }
  const paragraph = specs.length
  specs.push(['object', 'Object', []])
  const text = specs.length
  specs.push(['object', 'Object', []])
  const children = specs.length
  specs.push(['array', 'object', []])
  const value = specs.length
  specs.push(['string', 'ab', []])
  edge(6, 1, '0', paragraph)
  edge(paragraph, 0, 'type', value)
  edge(paragraph, 0, 'children', children)
  edge(children, 1, '0', text)
  edge(text, 0, 'type', value)
  edge(text, 0, 'value', value)
  if (history) {
    const oldState = specs.length
    specs.push(['object', 'object', []])
    const oldSnapshot = specs.length
    specs.push(['object', 'object', []])
    const oldInput = specs.length
    specs.push(['string', 'synthetic-old', []])
    edge(1, 0, 'previous', oldState)
    for (const [name, to] of [
      ['kind', 2],
      ['signature', 3],
      ['snapshot', oldSnapshot]
    ])
      edge(oldState, 0, name, to)
    for (const [name, to] of [
      ['input', oldInput],
      ['blocks', 6],
      ['accounting', 7],
      ['cut', 12],
      ['line', 14],
      ['rootStart', 15]
    ])
      edge(oldSnapshot, 0, name, to)
  }
  const nodes = [],
    edges = []
  const types = ['synthetic', 'object', 'string', 'array', 'hidden', 'closure', 'number']
  for (let i = 0; i < specs.length; i++) {
    const [type, name, es] = specs[i]
    nodes.push(types.indexOf(type), s(name), i + 1, 8, es.length, 0)
    for (const e of es) edges.push(...e)
  }
  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
        node_types: [types, 'string', 'number', 'number', 'number', 'number'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [
          ['property', 'element', 'context', 'weak', 'internal'],
          'string_or_number',
          'node'
        ]
      },
      node_count: specs.length,
      edge_count: edges.length / 3
    },
    nodes,
    edges,
    strings
  }
}
test('recognizes actual-shaped prefix and closure ownership through strong graph paths', () => {
  const r = inspectPrefixGraph(heap(), { expectedInput: 'synthetic-current' })
  assert.equal(r.matches.length, 1)
  assert.equal(r.storeContexts.length, 1)
  assert.ok(r.matches[0].path.length > 0)
  assert.equal(r.qualified, false)
})
test('weak-only retention cannot provide a positive warm match', () =>
  assert.throws(
    () =>
      inspectPrefixGraph(heap({ weak: true, missingContext: true }), {
        expectedInput: 'synthetic-current'
      }),
    /positive|context/
  ))
for (const [name, mutate] of Object.entries({
  missing: (h) => delete h.edges,
  truncated: (h) => h.nodes.pop(),
  badDestination: (h) => (h.edges[2] = 999999),
  missingMetadata: (h) => delete h.snapshot.meta,
  incompleteCount: (h) => h.snapshot.node_count++
}))
  test('rejects ' + name + ' graph', () => {
    const h = heap()
    mutate(h)
    assert.throws(() => decodeHeap(h))
    assert.doesNotThrow(() => decodeHeap(heap()))
  })
test('rejects unknown closure attribution rather than inventing zero', () =>
  assert.throws(
    () =>
      inspectPrefixGraph(heap({ missingContext: true }), { expectedInput: 'synthetic-current' }),
    /context/
  ))
test('rejects deliberately linked old generation/history', () =>
  assert.throws(
    () => inspectPrefixGraph(heap({ history: true }), { expectedInput: 'synthetic-current' }),
    /history|previous/
  ))
test('post-close absence requires prior positive warm evidence', () => {
  assert.throws(() => inspectPrefixGraph(heap({ closed: true }), { closed: true }), /positive/)
  const warm = inspectPrefixGraph(heap(), { expectedInput: 'synthetic-current' })
  assert.equal(inspectPrefixGraph(heap({ closed: true }), { closed: true, warm }).matches.length, 0)
})
test('post-close live probe prefix fails', () => {
  const warm = inspectPrefixGraph(heap(), { expectedInput: 'synthetic-current' })
  assert.throws(() => inspectPrefixGraph(heap(), { closed: true, warm }), /post-close/)
})
test('GC memory comparison rejects missing/incomplete/unqualified data and >20% growth', () => {
  const make = (cohort, size) => ({
    config: RESOURCE_CONFIG,
    cohort,
    status: { exitCode: 0, complete: true },
    qualified: true,
    runs: Array.from({ length: 3 }, (_, i) => ({
      run: i + 1,
      ok: true,
      closed: true,
      cleaned: true,
      pageErrors: [],
      observations: [
        { milestone: 'warm', usedSize: size, totalSize: size + 10 },
        ...Array.from({ length: 5 }, (_, j) => [
          { milestone: `cycle-${j + 1}-warm`, usedSize: size, totalSize: size + 10 },
          { milestone: `cycle-${j + 1}-closed`, usedSize: size, totalSize: size + 10 }
        ]).flat(),
        { milestone: 'final-closed', usedSize: size, totalSize: size + 10 }
      ],
      graphQualified: true
    }))
  })
  const hash = 'a'.repeat(64)
  const decorate = (c) =>
    Object.assign(c, {
      source: (c.cohort === 'r2' ? 'b' : 'c').repeat(40),
      toolingSha256: { 'scripts/performance/parser-resource.mjs': hash },
      provenance: {
        tree: 'd'.repeat(40),
        status: '',
        trackedOverlaySha256: hash,
        packageLockSha256: hash,
        buildSha256: { 'out/main/index.js': hash, 'out/renderer/index.html': hash },
        transitiveSha256: { 'scripts/performance/parser-resource.mjs': hash }
      }
    })
  const b = decorate(make('r2', 100)),
    a = decorate(make('candidate', 120))
  const frozen = {
    before: { source: b.source, buildSha256: b.provenance.buildSha256, trackedOverlaySha256: hash },
    after: { source: a.source, buildSha256: a.provenance.buildSha256, trackedOverlaySha256: hash },
    toolingSha256: b.toolingSha256,
    transitiveSha256: b.provenance.transitiveSha256
  }
  const compare = (before, after) =>
    checkResourceComparison(decorate(before), decorate(after), frozen)
  const before = make('r2', 100),
    after = make('candidate', 120)
  assert.equal(compare(before, after).ratio, 1.2)
  for (const mutate of [
    (c) => c.runs.pop(),
    (c) => c.runs[0].observations.pop(),
    (c) => (c.qualified = false),
    (c) => (c.status.exitCode = '0'),
    (c) => (c.runs[0].observations[0].usedSize = NaN),
    (c) => (c.runs[0].observations[0].totalSize = 1),
    (c) => (c.runs[0].graphQualified = false)
  ]) {
    const c = structuredClone(after)
    mutate(c)
    assert.throws(() => compare(before, c))
    assert.doesNotThrow(() => compare(before, after))
  }
  assert.throws(() => compare(before, make('candidate', 121)), /1.20/)
})

// Append representation nodes without changing the application's property/context schema.
function stringGraph() {
  const raw = heap(),
    width = raw.snapshot.meta.node_fields.length
  const intern = (text) => {
    let index = raw.strings.indexOf(text)
    if (index < 0) {
      index = raw.strings.length
      raw.strings.push(text)
    }
    return index
  }
  const enumIndex = (types, type) => {
    let index = types.indexOf(type)
    if (index < 0) {
      index = types.length
      types.push(type)
    }
    return index
  }
  const add = (type, name, links = []) => {
    const index = raw.snapshot.node_count++
    raw.nodes.push(
      enumIndex(raw.snapshot.meta.node_types[0], type),
      intern(name),
      index + 1,
      8,
      links.length,
      0
    )
    for (const [kind, label, target] of links) {
      raw.edges.push(
        enumIndex(raw.snapshot.meta.edge_types[0], kind),
        intern(label),
        target * width
      )
      raw.snapshot.edge_count++
    }
    return index
  }
  const rope = (
    first,
    second,
    links = [
      ['internal', 'first', first],
      ['internal', 'second', second]
    ]
  ) => add('concatenated string', '(concatenated string)', links)
  const input = (index) => {
    let replacements = 0
    for (let i = 0; i < raw.edges.length; i += 3)
      if (raw.strings[raw.edges[i + 1]] === 'input') {
        raw.edges[i + 2] = index * width
        replacements++
      }
    assert.equal(replacements, 1)
    return raw
  }
  return { raw, add, rope, input, base: 5 }
}
function recognize(g, index, expectedInput) {
  const result = inspectPrefixGraph(g.input(index), { expectedInput })
  assert.equal(result.matches.length, 1)
  assert.equal(result.storeContexts.length, 1)
  assert.equal(result.qualified, false)
  return result
}
test('recognizes cons strings through internal first/second links and internal closure context', () => {
  const g = stringGraph(),
    empty = g.add('string', ''),
    index = g.rope(g.base, empty)
  const result = recognize(g, index, 'synthetic-current')
  assert.ok(
    result.storeContexts[0].path.some((p) => p.edge === 'context' && p.edgeType === 'internal')
  )
  const decoded = decodeHeap(g.raw),
    contextId = result.storeContexts[0].nodeId
  for (const closure of result.storeContexts[0].closures)
    assert.ok(
      decoded.nodes
        .find((n) => n.id === closure.nodeId)
        .edges.some(
          (e) =>
            e.type === 'internal' && e.name === 'context' && decoded.nodes[e.to].id === contextId
        )
    )
  assert.deepEqual(
    [...decodeHeap(g.raw).properties(index)],
    [],
    'representation edges never enter application property map'
  )
})
test('retains property-shaped closure compatibility in the unchanged root reproducer', () =>
  assert.equal(
    inspectPrefixGraph(heap({ internalContext: false }), { expectedInput: 'synthetic-current' })
      .storeContexts.length,
    1
  ))
test('reconstructs a finite unbalanced rope with500numbered128-byte chunks', () => {
  const g = stringGraph()
  let index = g.base,
    expected = 'synthetic-current'
  for (let i = 0; i < 500; i++) {
    const chunk = `chunk${String(i).padStart(6, '0')} ` + 'a'.repeat(115) + ' '
    assert.equal(Buffer.byteLength(chunk), 128)
    index = g.rope(index, g.add('string', chunk))
    expected += chunk
  }
  recognize(g, index, expected)
})
test('shared finite subgraphs are reconstructed twice without a false cycle', () => {
  const g = stringGraph(),
    empty = g.add('string', ''),
    shared = g.rope(g.base, empty)
  recognize(g, g.rope(shared, shared), 'synthetic-currentsynthetic-current')
})
test('a finite500-level shared empty rope does not expand exponentially', () => {
  const g = stringGraph()
  let index = g.add('string', '')
  for (let i = 0; i < 500; i++) index = g.rope(index, index)
  recognize(g, g.rope(g.base, index), 'synthetic-current')
})
const malformed = {
  'missing second': (g) => g.rope(g.base, g.base, [['internal', 'first', g.base]]),
  'duplicate first': (g) =>
    g.rope(g.base, g.base, [
      ['internal', 'first', g.base],
      ['internal', 'first', g.base],
      ['internal', 'second', g.base]
    ]),
  'wrong edge category': (g) =>
    g.rope(g.base, g.base, [
      ['property', 'first', g.base],
      ['internal', 'second', g.base]
    ]),
  'weak representation link': (g) =>
    g.rope(g.base, g.base, [
      ['weak', 'first', g.base],
      ['internal', 'second', g.base]
    ]),
  'ambiguous category shadow': (g) =>
    g.rope(g.base, g.base, [
      ['internal', 'first', g.base],
      ['property', 'first', g.base],
      ['internal', 'second', g.base]
    ]),
  'non-string leaf': (g) => g.rope(g.base, 12),
  'self cycle': (g) => g.rope(g.raw.snapshot.node_count, g.base),
  'mutual cycle': (g) => {
    const index = g.raw.snapshot.node_count
    g.rope(index + 1, g.base)
    g.rope(index, g.base)
    return index
  },
  'sliced representation': (g) =>
    g.add('sliced string', '(sliced string)', [['internal', 'parent', g.base]]),
  'thin representation': (g) => g.add('string', '(thin string)', [['internal', 'actual', g.base]]),
  'unknown representation': (g) => g.add('unknown string', '(unknown string)'),
  'runtime string size overflow': (g) => {
    let index = g.base
    for (let i = 0; i < 32; i++) index = g.rope(index, index)
    return index
  }
}
for (const [name, make] of Object.entries(malformed))
  test('rejects ' + name + ' deterministically', () => {
    const g = stringGraph(),
      index = make(g)
    assert.throws(
      () => decodeHeap(g.input(index)).text(index),
      /rope|string shape|string representation|string size|cyclic/
    )
    const baseline = stringGraph()
    recognize(baseline, baseline.base, 'synthetic-current')
  })
test('a nonmatching/truncated label cannot establish exact current input', () => {
  const g = stringGraph(),
    index = g.add('string', 'synthetic-cur[truncated]')
  assert.throws(
    () => inspectPrefixGraph(g.input(index), { expectedInput: 'synthetic-current' }),
    /positive/
  )
})
test('ordinary internal map metadata stays outside the application field whitelist', () => {
  const g = stringGraph()
  g.raw.snapshot.meta.node_types[0].push('unused representation enum')
  const originalNodeCount = g.raw.snapshot.node_count
  const map = g.add('object', 'metadata')
  const internalState = g.add('object', 'object', [
    ['property', 'kind', 2],
    ['property', 'signature', 3],
    ['property', 'snapshot', 4],
    ['internal', 'map', map]
  ])
  // Retarget the store context's actual snapshot value to the source-shaped state.
  for (let i = 0; i < g.raw.edges.length; i += 3)
    if (g.raw.edges[i] === 2 && g.raw.strings[g.raw.edges[i + 1]] === 'snapshot')
      g.raw.edges[i + 2] = internalState * 6
  assert.equal(originalNodeCount, 23)
  const result = inspectPrefixGraph(g.raw, { expectedInput: 'synthetic-current' })
  assert.equal(result.storeContexts[0].stateId, internalState + 1)
  assert.equal(decodeHeap(g.raw).properties(internalState).has('map'), false)
})
test('explicit truncated metadata cannot establish a match from its display name', () => {
  const g = stringGraph(),
    truncated = g.add('hidden', 'true')
  const index = g.add('string', 'synthetic-current', [['internal', 'truncated', truncated]])
  assert.throws(
    () => inspectPrefixGraph(g.input(index), { expectedInput: 'synthetic-current' }),
    /unsupported heap string representation/
  )
})

function retarget(raw, label, to, edgeType) {
  let count = 0
  for (let i = 0; i < raw.edges.length; i += 3)
    if (
      raw.strings[raw.edges[i + 1]] === label &&
      (edgeType === undefined || raw.snapshot.meta.edge_types[0][raw.edges[i]] === edgeType)
    ) {
      raw.edges[i + 2] = to * raw.snapshot.meta.node_fields.length
      count++
    }
  assert.ok(count > 0)
}
function boilerplate(appOwned = false) {
  const g = stringGraph(),
    hole = g.add('hidden', 'system / Hole')
  const state = g.add('object', 'Object', [
    ['property', 'kind', 2],
    ['property', 'signature', hole],
    ['property', 'snapshot', hole]
  ])
  const site = g.add('code', 'system / AllocationSite', [
    ['internal', 'transition_info', state],
    ['internal', 'publisher', 11]
  ])
  retarget(g.raw, 'publisher', site, 'property')
  if (appOwned) retarget(g.raw, 'snapshot', state, 'context')
  return { g, state, site }
}
test('excludes only witnessed code AllocationSite Hole boilerplate', () => {
  const { g, state } = boilerplate()
  const result = inspectPrefixGraph(g.raw, { discoveryOnly: true })
  assert.equal(result.exclusions.length, 1)
  assert.equal(result.exclusions[0].nodeId, state + 1)
  assert.equal(result.exclusions[0].incoming[0].edge, 'transition_info')
  assert.equal(result.allPrefixes.length, 1)
})
test('app-owned Hole is an error even with a code AllocationSite holder', () => {
  const { g } = boilerplate(true)
  assert.throws(() => inspectPrefixGraph(g.raw, { discoveryOnly: true }), /app-owned/)
})
for (const mode of [
  'missing',
  'duplicate',
  'wrong-category',
  'wrong-target',
  'negative',
  'fraction',
  'nan',
  'infinity',
  'overflow',
  'leading-zero'
])
  test('strict real V8 numeric rejects ' + mode, () => {
    const g = stringGraph()
    const labels = {
      negative: '-1',
      fraction: '1.5',
      nan: 'NaN',
      infinity: 'Infinity',
      overflow: '9007199254740992',
      'leading-zero': '01'
    }
    const value = g.add(mode === 'wrong-target' ? 'object' : 'string', labels[mode] ?? '24')
    const links =
      mode === 'missing'
        ? []
        : [[mode === 'wrong-category' ? 'property' : 'internal', 'value', value]]
    if (mode === 'duplicate') links.push(['internal', 'value', value])
    const n = g.add('number', 'smi number', links)
    assert.throws(() => decodeHeap(g.raw).integer(n), /numeric|decimal|integer/)
  })
test('real numeric value does not use number display label', () => {
  const g = stringGraph(),
    value = g.add('string', '24'),
    n = g.add('number', 'smi number', [['internal', 'value', value]])
  assert.equal(decodeHeap(g.raw).integer(n), 24)
  assert.throws(() => decodeHeap(g.raw).integer(value), /typed number/)
})
test('structural recount is independent of reported nodes and blocks', () => {
  const g = stringGraph(),
    number = g.add('number', 'smi number', [['internal', 'value', g.add('string', '3')]])
  retarget(g.raw, 'nodes', number, 'property')
  assert.throws(() => inspectPrefixGraph(g.raw, { discoveryOnly: true }), /nodes recount/)
})
function freezeAll(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.values(o).forEach(freezeAll)
    Object.freeze(o)
  }
  return o
}
function immutablePrefix(input = 'ab tail') {
  const snapshot = {
    input,
    cut: 2,
    line: 1,
    blocks: [{ type: 'paragraph', children: [{ type: 'text', value: 'ab' }] }],
    rootStart: { line: 1, column: 1, offset: 0 },
    accounting: {
      blocks: 1,
      nodes: 2,
      sourceSpanCodeUnits: 2,
      astStringCodeUnits: 2,
      sourceBytes: 8
    }
  }
  return freezeAll({ kind: 'prefix', signature: 'remark-gfm4:singleTilde=true', snapshot })
}
function boundRow(state = immutablePrefix()) {
  return {
    nodeId: 101,
    snapshotId: 103,
    inputId: 105,
    cut: 2,
    line: 1,
    accounting: state.snapshot.accounting,
    structure: { blocks: 1, nodes: 2 }
  }
}
test('read-only immutable binding recounts full string units and matches same snapshot', () => {
  const state = immutablePrefix('ab\ud800 tail')
  const value = readBoundPrefix.call(state, state.snapshot)
  assert.equal(value.input, state.snapshot.input)
  const r = summarizeBoundPrefix(value, boundRow(state), [state.snapshot.input])
  assert.equal(r.inputCodeUnits, 8)
  assert.equal(r.encoding, 'utf16le')
  assert.equal(r.exactCanonical, true)
  assert.equal(Object.hasOwn(value, 'input'), false)
  assert.throws(() => readBoundPrefix.call(state, immutablePrefix().snapshot), /immutable/)
})
for (const mode of ['getter', 'unfrozen', 'unexpected', 'bad-account', 'cycle', 'over-cap'])
  test('live plain data refuses ' + mode, () => {
    const state = structuredClone(immutablePrefix())
    if (mode === 'getter')
      Object.defineProperty(state.snapshot, 'input', {
        get() {
          throw new Error('GETTER EXECUTED')
        }
      })
    if (mode === 'unexpected') state.snapshot.processor = {}
    if (mode === 'bad-account') state.snapshot.accounting.nodes = 1
    if (mode === 'cycle') state.snapshot.blocks[0].children = [state.snapshot.blocks[0]]
    if (mode === 'over-cap') state.snapshot.cut = 200000
    if (mode !== 'unfrozen') {
      // Avoid calling an adversarial getter in the test's own freezer.
      const stack = [state],
        seen = new Set()
      while (stack.length) {
        const o = stack.pop()
        if (!o || typeof o !== 'object' || seen.has(o)) continue
        seen.add(o)
        for (const d of Object.values(Object.getOwnPropertyDescriptors(o)))
          if ('value' in d) stack.push(d.value)
        Object.freeze(o)
      }
    }
    assert.throws(() => readBoundPrefix.call(state, state.snapshot), /immutable/)
  })
test('clipped display equality cannot substitute for full canonical identity', () => {
  const state = immutablePrefix('x'.repeat(1024)),
    value = readBoundPrefix.call(state, state.snapshot)
  assert.throws(
    () => summarizeBoundPrefix(value, boundRow(state), ['x'.repeat(2048)]),
    /exact declared/
  )
  assert.equal(Object.hasOwn(value, 'input'), false)
  const graph = inspectPrefixGraph(heap(), { expectedInput: 'synthetic-current' })
  assert.equal(graph.matches[0].inputIdentity, 'unbound')
  assert.equal(graph.matches[0].inputMatches, undefined)
})
function fiberPair() {
  const root = { tag: 3, stateNode: {} },
    fiber = { tag: 0, return: root },
    alternate = { tag: 0, return: root }
  fiber.alternate = alternate
  alternate.alternate = fiber
  root.child = fiber
  root.stateNode.current = root
  return { root, fiber, alternate }
}
test('owner proof distinguishes root.current reachability from return pointers', () => {
  const { root, fiber, alternate } = fiberPair()
  assert.equal(readOwnerFiber.call(fiber).branch, 'current')
  assert.equal(readOwnerFiber.call(alternate).branch, 'alternate')
  root.child = alternate
  assert.equal(readOwnerFiber.call(fiber).branch, 'alternate')
})
for (const mode of ['nonreciprocal', 'disconnected', 'ambiguous', 'cycle', 'getter'])
  test('owner rejects ' + mode, () => {
    const { root, fiber, alternate } = fiberPair()
    if (mode === 'nonreciprocal') alternate.alternate = null
    if (mode === 'disconnected') root.child = null
    if (mode === 'ambiguous') fiber.sibling = alternate
    if (mode === 'cycle') fiber.return = fiber
    if (mode === 'getter')
      Object.defineProperty(fiber, 'alternate', {
        get() {
          throw new Error('GETTER EXECUTED')
        }
      })
    assert.throws(() => readOwnerFiber.call(fiber), /Fiber|owner|reachability/)
  })
test('unknown, processor and history holders remain unresolved without generation allowance', () => {
  for (const label of ['processor', 'previous', 'history']) {
    const g = stringGraph(),
      unknown = g.add('object', 'Object', [
        ['property', label, 1],
        ['internal', 'publisher', 11]
      ])
    retarget(g.raw, 'publisher', unknown, 'property')
    const graph = inspectPrefixGraph(g.raw, { discoveryOnly: true })
    assert.equal(graph.ownership.qualified, false)
    assert.ok(graph.ownership.unresolved.some((r) => r.edge === label))
  }
})
function mockCdp({
  readFails = false,
  releaseFails = false,
  invalidation = 'missing',
  wrongSnapshot = false
} = {}) {
  const calls = [],
    live = new Map(),
    state = immutablePrefix(),
    row = boundRow(state)
  const session = {
    async send(method, params) {
      calls.push({ method, params })
      if (method === 'HeapProfiler.getObjectByHeapObjectId') {
        const handle = 'remote-' + params.objectId
        live.set(
          handle,
          params.objectId === '101'
            ? state
            : wrongSnapshot
              ? immutablePrefix().snapshot
              : state.snapshot
        )
        return { result: { objectId: handle } }
      }
      if (method === 'Runtime.releaseObjectGroup') {
        if (releaseFails) throw new Error('permission denied')
        live.clear()
        return {}
      }
      if (method === 'Runtime.callFunctionOn') {
        if (!live.has(params.objectId)) {
          if (invalidation === 'usable') return { result: { value: 1 } }
          throw new Error(
            invalidation === 'disconnect'
              ? 'session disconnected'
              : 'Could not find object with given id'
          )
        }
        if (readFails) throw new Error('mock read unsupported')
        const fn = Function('return (' + params.functionDeclaration + ')')()
        return {
          result: {
            value: fn.call(
              live.get(params.objectId),
              ...(params.arguments ?? []).map((a) => live.get(a.objectId))
            )
          }
        }
      }
      throw new Error('unexpected mock method ' + method)
    }
  }
  return { session, calls, state, row, graph: { allPrefixes: [row], ownership: { fibers: [] } } }
}
test('mock post-snapshot binding uses exact ids/group, returns no body and invalidates every handle', async () => {
  const m = mockCdp(),
    receipt = await bindCapturedGraph(m.session, m.graph, [m.state.snapshot.input])
  assert.deepEqual(
    m.calls
      .filter((c) => c.method === 'HeapProfiler.getObjectByHeapObjectId')
      .map((c) => c.params.objectId),
    ['101', '103']
  )
  assert.equal(receipt.invalidatedHandles, 2)
  assert.equal(receipt.qualified, false)
  assert.equal(JSON.stringify(receipt).includes(m.state.snapshot.input), false)
  assert.equal(m.calls.at(-1).method, 'Runtime.callFunctionOn')
})
for (const mode of ['readFails', 'releaseFails', 'wrongSnapshot', 'usable', 'disconnect'])
  test('mock binding propagates ' + mode + ' with cleanup attempt', async () => {
    const m = mockCdp(
      mode === 'usable' || mode === 'disconnect' ? { invalidation: mode } : { [mode]: true }
    )
    await assert.rejects(() => bindCapturedGraph(m.session, m.graph, [m.state.snapshot.input]))
    assert.ok(m.calls.some((c) => c.method === 'Runtime.releaseObjectGroup'))
  })
test('mock binding timeout is bounded and release is still attempted', async () => {
  const calls = []
  await assert.rejects(
    () =>
      bindCapturedGraph(
        {
          send(method) {
            calls.push(method)
            return method === 'Runtime.releaseObjectGroup'
              ? Promise.resolve({})
              : new Promise(() => {})
          }
        },
        { allPrefixes: [boundRow()], ownership: { fibers: [] } },
        [],
        { timeoutMs: 5 }
      ),
    /timeout/
  )
  assert.ok(calls.includes('Runtime.releaseObjectGroup'))
})
test('persisted warm and closed captures precede analysis even on representation failure', async () => {
  const calls = []
  const pair = await captureQualificationPair({
    capture: async (m) => {
      calls.push('persist-' + m)
      return { milestone: m }
    },
    bind: async (e) => {
      calls.push('bind-release-' + e.milestone)
      if (e.milestone === 'warm') throw new Error('unsupported shape')
    },
    close: async () => calls.push('close'),
    analyze: async (e) => {
      calls.push('analyze-' + e.milestone)
      return { qualified: false }
    }
  })
  assert.deepEqual(calls, [
    'persist-warm',
    'bind-release-warm',
    'close',
    'persist-final-closed',
    'bind-release-final-closed',
    'analyze-warm',
    'analyze-final-closed'
  ])
  assert.equal(pair.completedRawPair, true)
  assert.equal(pair.failures.length, 1)
  assert.equal(pair.qualified, false)
})
test('uncertain handle cleanup and semantic close failure stop before another capture', async () => {
  for (const cleanup of [true, false]) {
    const calls = []
    await assert.rejects(() =>
      captureQualificationPair({
        capture: async (m) => {
          calls.push(m)
          return { milestone: m }
        },
        bind: async () => {
          if (cleanup) throw new AggregateError([], 'cleanup')
        },
        close: async () => {
          throw new Error('semantic close failed')
        },
        analyze: async () => {
          throw new Error('must not analyze')
        }
      })
    )
    assert.deepEqual(calls, ['warm'])
  }
})

function retargetFrom(raw, index, label, to) {
  const width = raw.snapshot.meta.node_fields.length
  let start = 0
  for (let i = 0; i < index; i++) start += raw.nodes[i * width + 4] * 3
  for (let j = 0; j < raw.nodes[index * width + 4]; j++) {
    const at = start + j * 3
    if (raw.strings[raw.edges[at + 1]] === label) {
      raw.edges[at + 2] = to * width
      return
    }
  }
  assert.fail('missing test edge ' + label)
}
test('raw reciprocal Fiber pair derives finite hook and queue slots from the actual store', () => {
  const g = stringGraph(),
    store = g.add('object', 'Object', [['property', 'getSnapshot', 9]])
  const queue = g.add('object', 'Object', [['property', 'value', 1]])
  const sync = g.add('object', 'Object', [
    ['property', 'memoizedState', 1],
    ['property', 'queue', queue]
  ])
  const first = g.add('object', 'Object', [
    ['property', 'memoizedState', store],
    ['property', 'next', sync]
  ])
  const fiber = g.add('object', 'FiberNode', [
    ['property', 'memoizedState', first],
    ['property', 'alternate', 0],
    ['internal', 'publisher', 11]
  ])
  const alternate = g.add('object', 'FiberNode', [
    ['property', 'memoizedState', first],
    ['property', 'alternate', fiber]
  ])
  retargetFrom(g.raw, fiber, 'alternate', alternate)
  retarget(g.raw, 'publisher', fiber, 'property')
  const graph = inspectPrefixGraph(g.raw, { discoveryOnly: true })
  assert.equal(graph.ownership.fibers.length, 2)
  assert.ok(graph.ownership.fibers.every((f) => f.slots.length === 2))
  assert.equal(graph.ownership.unresolved.length, 0)
  assert.equal(graph.ownership.qualified, false)
})
test('internal backing array indices are recounted without entering application fields', () => {
  const g = stringGraph(),
    node = g.add('object', 'Object', [['property', 'type', 2]])
  const backing = g.add('array', '(object elements)', [['internal', '0', node]])
  const array = g.add('object', 'Array', [['internal', 'elements', backing]])
  const graph = decodeHeap(g.raw)
  assert.equal(graph.properties(array).has('elements'), false)
  // Bad node count must be caught after following the actual backing store.
  retarget(g.raw, 'blocks', array, 'property')
  assert.throws(() => inspectPrefixGraph(g.raw, { discoveryOnly: true }), /typed number|recount/)
})
test('read-only owner metadata reports terminal view separately and never invents DOM connectedness', () => {
  const { root, fiber } = fiberPair()
  const host = {
    tag: 5,
    memoizedProps: { className: 'chat-view terminal-view', 'data-session-id': 'synthetic-id' },
    child: fiber,
    return: root
  }
  root.child = host
  fiber.return = host
  const owner = readOwnerFiber.call(fiber)
  assert.deepEqual(owner.views, ['terminal'])
  assert.deepEqual(owner.sessionIds, ['synthetic-id'])
  assert.equal(owner.connected, null)
  assert.equal(owner.hostAncestorInCurrentTree, true)
})

test('canonical binding mismatch is semantic and prevents row close or second capture', async () => {
  const m = mockCdp(),
    calls = []
  await assert.rejects(
    () =>
      captureQualificationPair({
        capture: async (milestone) => {
          calls.push(milestone)
          return { milestone }
        },
        bind: () => bindCapturedGraph(m.session, m.graph, ['a different canonical value']),
        close: async () => calls.push('close'),
        analyze: async () => calls.push('analyze')
      }),
    /exact declared/
  )
  assert.deepEqual(calls, ['warm'])
  assert.ok(m.calls.some((c) => c.method === 'Runtime.releaseObjectGroup'))
})

test('actual checkpoint orchestration persists usage then complete raw before heap-id binding', async () => {
  const calls = [],
    m = mockCdp()
  const cdp = {
    async send(method, params) {
      calls.push(method)
      if (method === 'Runtime.getHeapUsage') return { usedSize: 100, totalSize: 200 }
      if (method === 'HeapProfiler.collectGarbage' || method === 'HeapProfiler.takeHeapSnapshot')
        return {}
      return m.session.send(method, params)
    }
  }
  const entry = await captureHeapCheckpoint(cdp, {
    persistUsage: async (usage) => {
      calls.push('persist-usage')
      return { milestone: 'warm', ...usage }
    },
    beginSnapshot: async () => calls.push('open-raw'),
    finishSnapshot: async () => calls.push('persist-complete-raw')
  })
  await bindCapturedGraph(cdp, m.graph, [m.state.snapshot.input])
  assert.equal(entry.usedSize, 100)
  assert.deepEqual(calls.slice(0, 8), [
    'Runtime.releaseObjectGroup',
    'HeapProfiler.collectGarbage',
    'HeapProfiler.collectGarbage',
    'Runtime.getHeapUsage',
    'persist-usage',
    'open-raw',
    'HeapProfiler.takeHeapSnapshot',
    'persist-complete-raw'
  ])
  assert.equal(calls[8], 'HeapProfiler.getObjectByHeapObjectId')
})
test('incomplete raw checkpoint cannot reach application object lookup', async () => {
  const calls = []
  await assert.rejects(
    () =>
      captureHeapCheckpoint(
        {
          async send(method) {
            calls.push(method)
            if (method === 'Runtime.getHeapUsage') return { usedSize: 100, totalSize: 200 }
            if (method === 'HeapProfiler.takeHeapSnapshot') throw new Error('incomplete raw')
            return {}
          }
        },
        {
          persistUsage: async () => ({}),
          beginSnapshot: async () => {},
          finishSnapshot: async () => assert.fail('no complete raw')
        }
      ),
    /incomplete raw/
  )
  assert.equal(calls.includes('HeapProfiler.getObjectByHeapObjectId'), false)
})
