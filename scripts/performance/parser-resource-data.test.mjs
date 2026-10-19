/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript heap graph fixtures */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  decodeHeap,
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
    ['number', '12', []],
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
  const edge = (from, type, name, to) => specs[from][2].push([type, s(name), to * 5])
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
    ['cut', 14],
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
      ['cut', 14],
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
    nodes.push(types.indexOf(type), s(name), i + 1, 8, es.length)
    for (const e of es) edges.push(...e)
  }
  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
        node_types: [types, 'string', 'number', 'number', 'number'],
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
      links.length
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
      g.raw.edges[i + 2] = internalState * 5
  assert.equal(originalNodeCount, 16)
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
