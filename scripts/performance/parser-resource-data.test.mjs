/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript heap graph fixtures */
import assert from 'node:assert/strict'
import inspector from 'node:inspector'
import vm from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { test } from 'vitest'
import {
  createMarkdownAttempt,
  createMarkdownStore
} from '../../plugins/chat-view/src/markdown-parser-reuse'
import { LONG_RESPONSE, streamChunk } from '../../tests/e2e/renderer-workload.mjs'
import {
  decodeHeap,
  readBoundPrefix,
  readOwnerFiber,
  summarizeBoundPrefix,
  bindCapturedGraph,
  captureQualificationPair,
  captureHeapCheckpoint,
  sanitizeExceptionDetails,
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
test('production positioned prefix retains accounting with bounded monitored reader calls', () => {
  const input = LONG_RESPONSE + Array.from({ length: 500 }, (_, i) => streamChunk(i)).join(''),
    store = createMarkdownStore(),
    attempt = createMarkdownAttempt(undefined, input, false, 'remark-gfm4:singleTilde=true')
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [[remarkGfm, { singleTilde: true }], attempt.plugin] },
      input
    )
  )
  assert.equal(attempt.ready(), true)
  store.publish(attempt.candidate())
  attempt.release()
  const state = store.getSnapshot()
  assert.equal(state.kind, 'prefix')
  assert.equal(state.snapshot.input.length, 98380)
  assert.equal(state.snapshot.cut, 34380)
  assert.equal(state.snapshot.line, 49)
  assert.deepEqual(state.snapshot.accounting, {
    blocks: 24,
    nodes: 2916,
    sourceSpanCodeUnits: 34380,
    astStringCodeUnits: 30444,
    sourceBytes: 129648
  })
  let positions = 0,
    frozenObjects = 0
  const pending = [state]
  while (pending.length) {
    const at = pending.pop()
    if (!at || typeof at !== 'object') continue
    assert.equal(Object.isFrozen(at), true)
    frozenObjects++
    if (at.type) {
      assert.ok(at.position)
      positions++
    }
    pending.push(...Object.values(at))
  }
  assert.equal(positions, 2916)
  assert.equal(frozenObjects, 12653)
  // Keep the original five-builtin redundancy regression and also count the
  // changed descriptor/predicate operations. Neither census is exhaustive,
  // a byte-size estimate, a wall-clock test or an inspector simulation.
  const inspect = (state, reader) => {
    const pending = [state]
    while (pending.length) {
      const at = pending.pop()
      if (!at || typeof at !== 'object') continue
      pending.push(...Object.values(at))
      Object.freeze(at)
    }
    const counts = {}
    for (const [owner, name] of [
      [Object, 'getOwnPropertyDescriptors'],
      [Object, 'getOwnPropertyDescriptor'],
      [Object, 'getPrototypeOf'],
      [Object, 'isFrozen'],
      [Object, 'hasOwn'],
      [Object, 'create'],
      [Object, 'entries'],
      [Object, 'keys'],
      [Reflect, 'ownKeys'],
      [Number, 'isSafeInteger'],
      [Array.prototype, 'includes']
    ]) {
      const original = owner[name]
      owner[name] = function (...args) {
        counts[name] = (counts[name] ?? 0) + 1
        return Reflect.apply(original, this, args)
      }
    }
    const value = reader.call(state, state.snapshot)
    if (value.input !== state.snapshot.input) throw new Error('full input mismatch')
    delete value.input
    return { counts, value }
  }
  const result = vm.runInNewContext(
    '(' + inspect.toString() + ')(' + JSON.stringify(state) + ',' + readBoundPrefix.toString() + ')'
  )
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), {
    cut: 34380,
    line: 49,
    accounting: state.snapshot.accounting,
    deepFrozen: true,
    sameSnapshot: true
  })
  const legacyCalls = ['getOwnPropertyDescriptors', 'create', 'entries', 'keys', 'ownKeys'].reduce(
    (sum, name) => sum + (result.counts[name] ?? 0),
    0
  )
  assert.ok(legacyCalls <= 3 * frozenObjects, 'redundant per-object reader allocation regression')
  const monitoredCalls = Object.values(result.counts).reduce((sum, count) => sum + count, 0)
  assert.ok(monitoredCalls <= 165000, 'fixed-shape checked-operation regression')
})

function fixedShapeFixture(shape, mode, field) {
  const state = structuredClone(immutablePrefix()),
    paragraph = state.snapshot.blocks[0]
  paragraph.position = {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 3, offset: 2 }
  }
  const container = shape === 'point' ? paragraph.position : paragraph,
    key = shape === 'point' ? 'end' : 'position',
    expected = field ?? (shape === 'point' ? 'line' : 'start')
  let target = container[key],
    calls = 0,
    skipped
  if (mode === 'null-prototype') Object.setPrototypeOf(target, null)
  if (mode === 'reordered') {
    target = Object.fromEntries(Object.entries(target).reverse())
    container[key] = target
  }
  if (mode === 'expected-nonenumerable')
    Object.defineProperty(target, expected, { enumerable: false })
  if (mode === 'missing') delete target[expected]
  if (
    ['replacement', 'symbol-replacement', 'hidden-replacement', 'proto-replacement'].includes(mode)
  )
    delete target[expected]
  if (['extra', 'replacement'].includes(mode)) target.extra = 1
  if (['symbol', 'symbol-replacement'].includes(mode)) target[Symbol('extra')] = 1
  if (['hidden', 'hidden-replacement'].includes(mode))
    Object.defineProperty(target, 'extra', { value: 1, enumerable: false })
  if (mode === 'proto-replacement')
    Object.defineProperty(target, '__proto__', { value: null, enumerable: true })
  if (['getter', 'hidden-getter'].includes(mode))
    Object.defineProperty(target, expected, {
      enumerable: mode !== 'hidden-getter',
      get() {
        calls++
        return 'never read'
      }
    })
  if (mode === 'prototype')
    Object.setPrototypeOf(target, {
      get [expected]() {
        calls++
        return 'never read'
      }
    })
  if (['unfrozen', 'sealed-mutable'].includes(mode)) {
    skipped = target
    if (mode === 'sealed-mutable') Object.seal(target)
  }
  if (mode === 'null') container[key] = null
  if (mode === 'array') container[key] = []
  if (mode === 'primitive') container[key] = 1
  if (mode === 'function') container[key] = () => 1
  if (mode === 'reversed-position') {
    paragraph.position.start.offset = 2
    paragraph.position.end.offset = 1
  }
  if (shape === 'point') {
    const changes = {
      'offset-fraction': { offset: 0.5 },
      'offset-negative': { offset: -1 },
      'offset-overflow': { offset: Number.MAX_SAFE_INTEGER + 1 },
      'offset-nan': { offset: NaN },
      'offset-infinite': { offset: Infinity },
      'offset-string': { offset: '2' },
      'offset-input-bound': { offset: 8 },
      'offset-cut-bound': { offset: 3 },
      'line-zero': { line: 0 },
      'line-negative': { line: -1 },
      'line-fraction': { line: 0.5 },
      'column-zero': { column: 0 },
      'column-negative': { column: -1 },
      'column-fraction': { column: 0.5 },
      'offset-before-line': { offset: NaN, line: 0 },
      'line-before-column': { line: 0, column: NaN }
    }
    if (changes[mode]) Object.assign(target, changes[mode])
  }
  const seen = new Set(),
    pending = [state]
  while (pending.length) {
    const at = pending.pop()
    if (!at || typeof at !== 'object' || seen.has(at)) continue
    seen.add(at)
    for (const d of Object.values(Object.getOwnPropertyDescriptors(at)))
      if ('value' in d) pending.push(d.value)
    if (at !== skipped) Object.freeze(at)
  }
  return { state, calls: () => calls }
}
const fixedShapeCases = [
  ['valid', null],
  ['null-prototype', null],
  ['reordered', null],
  ['expected-nonenumerable', null],
  ['extra', 'data-fields'],
  ['symbol', 'data-fields'],
  ['hidden', 'data-fields'],
  ['replacement', 'data-fields'],
  ['symbol-replacement', 'data-fields'],
  ['hidden-replacement', 'data-fields'],
  ['proto-replacement', 'data-fields'],
  ['getter', 'data-fields'],
  ['hidden-getter', 'data-fields'],
  ['prototype', 'plain-object'],
  ['unfrozen', 'frozen'],
  ['sealed-mutable', 'frozen'],
  ['null', 'plain-object'],
  ['array', 'plain-object'],
  ['primitive', 'plain-object'],
  ['function', 'plain-object']
]
for (const shape of ['point', 'position'])
  for (const [mode, reason] of [
    ...fixedShapeCases,
    ['missing', shape === 'point' ? 'integer' : 'plain-object'],
    ['reversed-position', 'position']
  ])
    test('fixed ' + shape + ' own-data guard ' + mode, () => {
      const { state, calls } = fixedShapeFixture(shape, mode)
      if (reason)
        assert.throws(
          () => readBoundPrefix.call(state, state.snapshot),
          new RegExp('invalid immutable prefix binding: ' + reason)
        )
      else {
        const value = readBoundPrefix.call(state, state.snapshot)
        assert.equal(value.input, state.snapshot.input)
        assert.equal(value.accounting.nodes, 2)
        assert.equal(value.deepFrozen, true)
      }
      assert.equal(calls(), 0)
    })
for (const [shape, field] of [
  ['point', 'column'],
  ['point', 'offset'],
  ['position', 'end']
])
  for (const mode of ['getter', 'hidden-getter'])
    test('fixed ' + shape + ' own-data guard ' + field + ' ' + mode, () => {
      const { state, calls } = fixedShapeFixture(shape, mode, field)
      assert.throws(
        () => readBoundPrefix.call(state, state.snapshot),
        /invalid immutable prefix binding: data-fields/
      )
      assert.equal(calls(), 0)
    })
const fixedPointNumbers = [
  ['offset-fraction', 'integer'],
  ['offset-negative', 'integer'],
  ['offset-overflow', 'integer'],
  ['offset-nan', 'integer'],
  ['offset-infinite', 'integer'],
  ['offset-string', 'integer'],
  ['offset-input-bound', 'point'],
  ['offset-cut-bound', 'position'],
  ['line-zero', 'point'],
  ['line-negative', 'integer'],
  ['line-fraction', 'integer'],
  ['column-zero', 'point'],
  ['column-negative', 'integer'],
  ['column-fraction', 'integer'],
  ['offset-before-line', 'integer'],
  ['line-before-column', 'point']
]
for (const [mode, reason] of fixedPointNumbers)
  test('fixed point numeric guard ' + mode, () => {
    const { state, calls } = fixedShapeFixture('point', mode)
    assert.throws(
      () => readBoundPrefix.call(state, state.snapshot),
      new RegExp('invalid immutable prefix binding: ' + reason)
    )
    assert.equal(calls(), 0)
  })

for (const field of ['position', 'children', 'depth', 'value', 'url', 'title', 'alt'])
  test('absent own ' + field + ' never invokes an inherited getter', () => {
    const inspect = (state, reader, field) => {
      const pending = [state]
      while (pending.length) {
        const at = pending.pop()
        if (!at || typeof at !== 'object') continue
        pending.push(...Object.values(at))
        Object.freeze(at)
      }
      let touched = 0
      const descriptor = Object.create(null)
      descriptor.get = () => {
        touched++
        return 'inherited value'
      }
      descriptor.configurable = true
      Object.defineProperty(Object.prototype, field, descriptor)
      const value = reader.call(state, state.snapshot)
      delete value.input
      return { touched, value }
    }
    const result = vm.runInNewContext(
      '(' +
        inspect.toString() +
        ')(' +
        JSON.stringify(immutablePrefix()) +
        ',' +
        readBoundPrefix.toString() +
        ',' +
        JSON.stringify(field) +
        ')'
    )
    assert.equal(result.touched, 0)
    assert.equal(result.value.accounting.nodes, 2)
    assert.equal(result.value.deepFrozen, true)
  })
for (const mode of [
  'prototype',
  'shared-node',
  'symbol',
  'optional-getter',
  'unfrozen-point',
  'position-cut'
])
  test('descriptor reuse keeps ' + mode + ' rejection', () => {
    const state = structuredClone(immutablePrefix()),
      paragraph = state.snapshot.blocks[0]
    let touched = 0
    if (mode === 'prototype')
      Object.setPrototypeOf(paragraph, {
        get value() {
          touched++
          return 'inherited value'
        }
      })
    if (mode === 'shared-node') paragraph.children.push(paragraph.children[0])
    if (mode === 'symbol') paragraph[Symbol('extra')] = 1
    if (mode === 'optional-getter')
      Object.defineProperty(paragraph.children[0], 'url', {
        get() {
          touched++
          return 'inherited value'
        }
      })
    paragraph.position = {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 4, offset: mode === 'position-cut' ? 3 : 2 }
    }
    const skipped = mode === 'unfrozen-point' ? paragraph.position.end : null,
      seen = new Set(),
      pending = [state]
    while (pending.length) {
      const at = pending.pop()
      if (!at || typeof at !== 'object' || seen.has(at)) continue
      seen.add(at)
      for (const d of Object.values(Object.getOwnPropertyDescriptors(at)))
        if ('value' in d) pending.push(d.value)
      if (at !== skipped) Object.freeze(at)
    }
    const reason = {
      prototype: 'plain-object',
      'shared-node': 'ast-cycle',
      symbol: 'data-fields',
      'optional-getter': 'data-fields',
      'unfrozen-point': 'frozen',
      'position-cut': 'position'
    }[mode]
    assert.throws(
      () => readBoundPrefix.call(state, state.snapshot),
      new RegExp('invalid immutable prefix binding: ' + reason)
    )
    assert.equal(touched, 0)
  })
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
function hotOwnerFixture(mode = 'valid', className = 'chat-view terminal-view') {
  let calls = 0
  const root = { tag: 3, stateNode: {} },
    host = {
      tag: 5,
      return: root,
      memoizedProps: { className, 'data-session-id': 'host-session' }
    },
    owner = { tag: 0, return: host, memoizedProps: { sessionId: 'owner-session' } },
    alternate = { tag: 0, return: host, memoizedProps: { sessionId: 'owner-session' } },
    other = { tag: 0, return: host }
  owner.alternate = alternate
  alternate.alternate = owner
  root.stateNode.current = root
  root.child = host
  host.child = owner
  owner.sibling = other
  alternate.sibling = other
  const getter = (object, key) =>
    Object.defineProperty(object, key, {
      get() {
        calls++
        return 'never read'
      }
    })
  if (mode === 'opposite') host.child = alternate
  if (mode === 'ambiguous-after-found') other.child = alternate
  if (mode === 'disconnected') host.child = null
  if (mode === 'query-child-getter') getter(owner, 'child')
  if (mode === 'query-sibling-getter') getter(owner, 'sibling')
  if (mode === 'other-child-getter') getter(other, 'child')
  if (mode === 'other-sibling-getter') getter(other, 'sibling')
  if (mode === 'inherited-child-getter' || mode === 'inherited-sibling-getter') {
    const prototype = {}
    getter(prototype, mode === 'inherited-child-getter' ? 'child' : 'sibling')
    Object.setPrototypeOf(other, prototype)
  }
  if (mode === 'primitive-refs') {
    other.child = 1
    other.sibling = 'text'
  }
  if (mode === 'symbol-bigint-refs') {
    other.child = Symbol('leaf')
    other.sibling = 1n
  }
  if (mode === 'function-ref' || mode === 'function-ambiguous') {
    const leaf = () => 0
    other.child = leaf
    leaf.child = mode === 'function-ambiguous' ? alternate : { tag: 0 }
    leaf.sibling = other
  }
  const falsies = {
    null: null,
    undefined: undefined,
    false: false,
    zero: 0,
    nan: NaN,
    empty: '',
    bigint: 0n
  }
  if (mode.startsWith('falsy-')) {
    other.child = falsies[mode.slice(6)]
    other.sibling = falsies[mode.slice(6)]
  }
  if (mode === 'shared-cycle') {
    owner.child = other
    other.child = other
    other.sibling = host
  }
  if (mode === 'nonreciprocal') alternate.alternate = null
  if (mode === 'return-cycle') owner.return = owner
  if (mode === 'return-getter') getter(owner, 'return')
  if (mode === 'alternate-getter') getter(owner, 'alternate')
  if (mode === 'root-current-getter') getter(root.stateNode, 'current')
  if (mode === 'missing-root') root.tag = 0
  if (mode === 'missing-current') root.stateNode.current = null
  if (mode === 'host-not-current') root.child = owner
  if (mode === 'session-getter') getter(host.memoizedProps, 'data-session-id')
  if (mode === 'props-getter') getter(host.memoizedProps, 'className')
  if (mode === 'unused-props-getter') getter(other, 'memoizedProps')
  return { owner, alternate, root, other, getterCalls: () => calls }
}
const hotOwnerCases = [
  ['valid', null],
  ['opposite', null],
  ['query-child-getter', 'owner getter refused'],
  ['query-sibling-getter', 'owner getter refused'],
  ['other-child-getter', 'owner getter refused'],
  ['other-sibling-getter', 'owner getter refused'],
  ['ambiguous-after-found', 'ambiguous current/alternate reachability'],
  ['disconnected', 'ambiguous current/alternate reachability'],
  ['inherited-child-getter', null],
  ['inherited-sibling-getter', null],
  ['primitive-refs', null],
  ['symbol-bigint-refs', null],
  ['function-ref', null],
  ['function-ambiguous', 'ambiguous current/alternate reachability'],
  ...['null', 'undefined', 'false', 'zero', 'nan', 'empty', 'bigint'].map((x) => [
    'falsy-' + x,
    null
  ]),
  ['shared-cycle', null],
  ['nonreciprocal', 'nonreciprocal Fiber alternate'],
  ['return-cycle', 'Fiber return cycle'],
  ['return-getter', 'owner getter refused'],
  ['alternate-getter', 'owner getter refused'],
  ['root-current-getter', 'owner getter refused'],
  ['missing-root', 'missing HostRoot current'],
  ['missing-current', 'missing HostRoot current'],
  ['host-not-current', null],
  ['session-getter', 'owner getter refused'],
  ['props-getter', 'owner getter refused'],
  ['unused-props-getter', null]
]
for (const [mode, reason] of hotOwnerCases)
  test('whole owner tree preserves ' + mode, () => {
    const fixture = hotOwnerFixture(mode)
    if (reason)
      assert.throws(() => readOwnerFiber.call(fixture.owner), { name: 'Error', message: reason })
    else {
      let value
      assert.doesNotThrow(() => {
        value = readOwnerFiber.call(fixture.owner)
      })
      assert.deepEqual(value, {
        branch: mode === 'opposite' ? 'alternate' : 'current',
        reciprocal: true,
        sessionIds: ['owner-session', 'host-session'],
        views: ['terminal'],
        hostAncestorInCurrentTree: mode !== 'host-not-current',
        connected: null,
        currentReachable: true
      })
    }
    assert.equal(fixture.getterCalls(), 0)
  })
test('whole owner tree validates the reciprocal alternate against the same current root', () => {
  const { alternate } = hotOwnerFixture()
  assert.equal(readOwnerFiber.call(alternate).branch, 'alternate')
})
test('owner child descriptor is validated before sibling without invoking either getter', () => {
  const events = [],
    fixture = hotOwnerFixture(),
    target = {}
  Object.defineProperty(target, 'child', {
    get() {
      throw new Error('getter executed')
    }
  })
  const other = new Proxy(target, {
    getOwnPropertyDescriptor(object, key) {
      events.push(key)
      return Reflect.getOwnPropertyDescriptor(object, key)
    }
  })
  fixture.owner.sibling = other
  assert.throws(() => readOwnerFiber.call(fixture.owner), /owner getter refused/)
  assert.deepEqual(events, ['child'])
})
test('owner reads child data before obtaining the sibling descriptor', () => {
  const events = [],
    fixture = hotOwnerFixture()
  fixture.owner.sibling = new Proxy(
    {},
    {
      getOwnPropertyDescriptor(object, key) {
        events.push(key)
        return Reflect.getOwnPropertyDescriptor(object, key)
      }
    }
  )
  readOwnerFiber.call(fixture.owner)
  assert.deepEqual(events, ['child', 'sibling'])
})
test('owner preserves sibling-before-child DFS order after both descriptor reads', () => {
  const events = [],
    fixture = hotOwnerFixture()
  const leaf = (label) =>
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor(object, key) {
          events.push(label + ':' + key)
          return Reflect.getOwnPropertyDescriptor(object, key)
        }
      }
    )
  fixture.owner.child = leaf('child')
  fixture.owner.sibling = leaf('sibling')
  readOwnerFiber.call(fixture.owner)
  assert.deepEqual(events, ['sibling:child', 'sibling:sibling', 'child:child', 'child:sibling'])
})
for (const separator of ['\v', '\f'])
  test('owner keeps exact control whitespace U+' + separator.charCodeAt(0).toString(16), () => {
    const { owner, alternate } = hotOwnerFixture('valid', 'chat-view' + separator + 'terminal-view')
    assert.deepEqual(readOwnerFiber.call(owner).views, ['terminal'])
    assert.deepEqual(readOwnerFiber.call(alternate).views, ['terminal'])
  })
test('whole owner tree retains the million-node bound after finding its query', () => {
  const fixture = hotOwnerFixture()
  let at = fixture.other
  for (let i = 0; i < 1000000; i++) {
    at.child = {}
    at = at.child
  }
  assert.throws(() => readOwnerFiber.call(fixture.owner), {
    name: 'Error',
    message: 'Fiber traversal bound'
  })
})
function representativeOwnerFixture(mode = 'valid') {
  let calls = 0
  const root = { tag: 3, stateNode: {} }
  let parent = root,
    host
  for (let i = 0; i < 40; i++) {
    const next = { tag: i === 0 ? 5 : 0, return: parent }
    if (i === 0) {
      host = next
      host.memoizedProps = {
        className: 'chat-view terminal-view',
        'data-session-id': 'synthetic-representative-session'
      }
    }
    parent.child = next
    parent = next
  }
  const owner = { tag: 0, return: parent },
    alternate = { tag: 0, return: parent }
  parent.child = owner
  owner.alternate = alternate
  alternate.alternate = owner
  root.stateNode.current = root
  const remaining = 40903 - 42,
    nodes = []
  for (let i = 0; i < remaining; i++) nodes.push({ tag: 0 })
  owner.child = nodes[0]
  nodes[0].return = owner
  for (let i = 0; i < nodes.length; i++) {
    const left = 2 * i + 1,
      right = left + 1
    if (left < nodes.length) {
      nodes[i].child = nodes[left]
      nodes[left].return = nodes[i]
      if (right < nodes.length) {
        nodes[left].sibling = nodes[right]
        nodes[right].return = nodes[i]
      }
    }
  }
  const seen = new Set(),
    pending = [root]
  while (pending.length) {
    const at = pending.pop()
    if (!at || seen.has(at)) continue
    seen.add(at)
    pending.push(at.child, at.sibling)
  }
  const depth = (at) => {
    let count = 0
    const visited = new Set()
    while (at) {
      if (visited.has(at)) throw new Error('synthetic owner ancestor cycle')
      visited.add(at)
      count++
      at = at.return
    }
    return count
  }
  const proof = {
    constructedFibers: nodes.length + 43,
    currentTreeFibers: seen.size,
    currentAncestorDepth: depth(owner),
    alternateAncestorDepth: depth(alternate),
    ownerInCurrent: seen.has(owner),
    alternateInCurrent: seen.has(alternate),
    hostInCurrent: seen.has(host),
    rootCurrentSame: root.stateNode.current === root,
    reciprocal: owner.alternate === alternate && alternate.alternate === owner
  }
  if (
    proof.currentTreeFibers !== 40903 ||
    proof.currentAncestorDepth !== 42 ||
    proof.alternateAncestorDepth !== 42 ||
    !proof.ownerInCurrent ||
    proof.alternateInCurrent ||
    !proof.hostInCurrent ||
    !proof.rootCurrentSame ||
    !proof.reciprocal
  )
    throw new Error('representative owner fixture shape mismatch')
  if (mode === 'props-getter')
    Object.defineProperty(host.memoizedProps, 'className', {
      get() {
        calls++
        return 'never read'
      }
    })
  if (mode === 'return-getter')
    for (const at of [owner, alternate])
      Object.defineProperty(at, 'return', {
        get() {
          calls++
          return parent
        }
      })
  return { owner, alternate, proof, getterCalls: () => calls }
}

test('full representative owner keeps global proof with bounded pending traversal', () => {
  const inspect = (fixture, reader) => {
    const bundle = fixture(),
      counts = {}
    for (const [object, name] of [
      [Array.prototype, 'pop'],
      [Array.prototype, 'push'],
      [Object, 'getOwnPropertyDescriptor'],
      [Set.prototype, 'has'],
      [Set.prototype, 'add']
    ]) {
      const original = object[name]
      object[name] = function (...args) {
        counts[name] = (counts[name] ?? 0) + 1
        return Reflect.apply(original, this, args)
      }
    }
    return {
      counts,
      proof: bundle.proof,
      value: reader.call(bundle.owner),
      getters: bundle.getterCalls()
    }
  }
  const result = vm.runInNewContext(
    '(' +
      inspect.toString() +
      ')(' +
      representativeOwnerFixture.toString() +
      ',' +
      readOwnerFiber.toString() +
      ')'
  )
  assert.equal(result.proof.currentTreeFibers, 40903)
  assert.equal(result.proof.currentAncestorDepth, 42)
  assert.equal(result.getters, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), {
    branch: 'current',
    reciprocal: true,
    sessionIds: ['synthetic-representative-session'],
    views: ['terminal'],
    hostAncestorInCurrentTree: true,
    connected: null,
    currentReachable: true
  })
  // This partial census counts actual calls, not allocation bytes, exhaustive
  // operations, inspector cost or a wall-clock threshold. Full graph is required.
  assert.ok(result.counts.getOwnPropertyDescriptor >= 81806)
  assert.ok(result.counts.pop <= 50000, 'redundant falsy pending traversal regression')
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
  wrongSnapshot = false,
  returnedException,
  missingValue = false
} = {}) {
  const calls = [],
    live = new Map(),
    groups = new Map(),
    state = immutablePrefix(),
    row = boundRow(state)
  const session = {
    async send(method, params) {
      calls.push({ method, params })
      if (method === 'Runtime.getHeapUsage')
        return {
          usedSize: 100 + 20 * calls.filter((c) => c.method === 'Runtime.getHeapUsage').length,
          totalSize: 300
        }
      if (method === 'HeapProfiler.getObjectByHeapObjectId') {
        assert.equal(params.objectGroup, 'parser-resource-binding')
        const handle = 'remote-' + params.objectId
        live.set(
          handle,
          params.objectId === '101'
            ? state
            : wrongSnapshot
              ? immutablePrefix().snapshot
              : state.snapshot
        )
        groups.set(handle, params.objectGroup)
        return { result: { objectId: handle } }
      }
      if (method === 'Runtime.releaseObjectGroup') {
        if (releaseFails) throw new Error('permission denied')
        for (const [handle, group] of groups) if (group === params.objectGroup) live.delete(handle)
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
        assert.equal(params.throwOnSideEffect, true)
        assert.equal(params.returnByValue, true)
        assert.equal(params.objectGroup, groups.get(params.objectId))
        if (readFails) throw new Error('mock read unsupported')
        if (returnedException) return { exceptionDetails: returnedException }
        if (missingValue) return { result: { type: 'undefined' } }
        const fn = Function('return (' + params.functionDeclaration + ')')()
        try {
          return {
            result: {
              value: fn.call(
                live.get(params.objectId),
                ...(params.arguments ?? []).map((a) => live.get(a.objectId))
              )
            }
          }
        } catch (error) {
          return {
            exceptionDetails: {
              text: 'Uncaught',
              lineNumber: 0,
              columnNumber: 0,
              exception: {
                type: 'object',
                subtype: 'error',
                className: error.name,
                description: error.name + ': ' + error.message
              }
            }
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
  assert.equal(m.calls.at(-1).method, 'Runtime.getHeapUsage')
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
  assert.equal(calls[8], 'Runtime.getHeapUsage')
  assert.equal(calls[9], 'HeapProfiler.getObjectByHeapObjectId')
  assert.equal(calls.at(-1), 'Runtime.getHeapUsage')
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

function returnedDetails(
  className = 'EvalError',
  description = 'EvalError: Possible side-effect in debug-evaluate'
) {
  return {
    text: 'Uncaught',
    lineNumber: 7,
    columnNumber: 9,
    exception: { type: 'object', subtype: 'error', className, description }
  }
}
test('protocol sanitizer keeps only bounded data-free diagnostics, no body/ids/URLs/getters', () => {
  const marker = 'INJECTED_SYNTHETIC_BODY',
    details = returnedDetails()
  details.exception.description += '\n' + marker + ' https://private.invalid'
  details.exception.value = marker
  details.exception.preview = { body: marker }
  details.exception.objectId = marker
  details.url = 'file:///private'
  details.stackTrace = {
    callFrames: Array.from({ length: 15 }, (_, i) => ({
      functionName: i ? 'https://private.invalid/' + marker : 'data',
      lineNumber: i,
      columnNumber: i,
      url: 'file:///private',
      scriptId: marker
    }))
  }
  const record = sanitizeExceptionDetails(details),
    text = JSON.stringify(record)
  assert.equal(record.exception.className, 'EvalError')
  assert.equal(record.exception.description, 'EvalError: Possible side-effect in debug-evaluate')
  assert.equal(record.stackTrace.callFrames.length, 10)
  for (const blocked of [
    marker,
    'https://',
    'file://',
    'objectId',
    'preview',
    'scriptId',
    'url',
    'value'
  ])
    assert.equal(text.includes(blocked), false, blocked)
  assert.equal(record.stackTrace.callFrames[0].functionName, 'data')
  details.text = marker.repeat(1000)
  details.exception.description = 'TypeError: ' + marker
  details.exception.className = marker
  details.lineNumber = -1
  details.columnNumber = Infinity
  const other = sanitizeExceptionDetails(details)
  assert.equal(other.text, '[redacted]')
  assert.equal(other.exception.description, '[redacted remote description]')
  assert.equal(Object.hasOwn(other, 'lineNumber'), false)
  assert.equal(Object.hasOwn(other, 'columnNumber'), false)
  let called = 0
  Object.defineProperty(details, 'text', {
    get() {
      called++
      return marker
    }
  })
  sanitizeExceptionDetails(details)
  assert.equal(called, 0)
})
for (const [className, description] of [
  ['EvalError', 'EvalError: Possible side-effect in debug-evaluate'],
  ['TypeError', 'TypeError: untrusted synthetic data']
])
  test(
    'returned ' +
      className +
      ' persists protocol/stage through closed pair, not a thrown transport mock',
    async () => {
      const m = mockCdp({ returnedException: returnedDetails(className, description) }),
        calls = []
      const pair = await captureQualificationPair({
        capture: async (milestone) => {
          calls.push('persist-' + milestone)
          return { milestone }
        },
        bind: (entry) =>
          bindCapturedGraph(
            m.session,
            entry.milestone === 'warm' ? m.graph : { allPrefixes: [], ownership: { fibers: [] } },
            [m.state.snapshot.input],
            { phase: entry.milestone }
          ),
        close: async () => calls.push('close'),
        analyze: async () => ({ qualified: false })
      })
      assert.deepEqual(calls, ['persist-warm', 'close', 'persist-final-closed'])
      const entry = pair.observations[0],
        failure = entry.bindingFailure
      assert.equal(failure.name, 'Error')
      assert.equal(failure.toolMessage, 'read-only binding exception')
      assert.equal(failure.stage, 'prefix-state-read')
      assert.equal(failure.phase, 'warm')
      assert.equal(failure.rowIndex, 0)
      assert.equal(failure.stateId, 101)
      assert.equal(failure.snapshotId, 103)
      assert.equal(failure.protocol.exception.className, className)
      assert.equal(failure.protocol.lineNumber, 7)
      assert.deepEqual(pair.failures[0].protocol, failure.protocol)
      assert.deepEqual(entry.bindingPartial.failures[0].protocol, failure.protocol)
      assert.equal(entry.bindingPartial.released, true)
      assert.equal(entry.bindingPartial.invalidatedHandles, 2)
      assert.equal(pair.qualified, false)
      assert.equal(
        m.calls.filter(
          (c) => c.method === 'Runtime.callFunctionOn' && c.params.arguments?.length
        )[0].params.throwOnSideEffect,
        true
      )
    }
  )
test('returned own validation exception persists semantic code and cleanup before stopping lifecycle', async () => {
  const m = mockCdp({
      returnedException: returnedDetails('Error', 'Error: invalid immutable prefix binding: frozen')
    }),
    observations = [],
    calls = []
  await assert.rejects(
    () =>
      captureQualificationPair({
        capture: async (milestone) => {
          const entry = { milestone }
          observations.push(entry)
          return entry
        },
        bind: (e) =>
          bindCapturedGraph(m.session, m.graph, [m.state.snapshot.input], { phase: e.milestone }),
        close: async () => calls.push('close'),
        analyze: async () => ({})
      }),
    (e) => e.name === 'QualificationSemanticError'
  )
  assert.deepEqual(calls, [])
  assert.equal(
    observations[0].bindingFailure.protocol.exception.description,
    'Error: invalid immutable prefix binding: frozen'
  )
  assert.equal(observations[0].bindingPartial.invalidatedHandles, 2)
  assert.equal(observations[0].bindingPartial.diagnosticUsage.after.usedSize, 140)
})
test('returned exception object handles are transient, released and invalidated, never persisted', async () => {
  const details = returnedDetails()
  details.exception.objectId = 'synthetic-exception-handle'
  const m = mockCdp({ returnedException: details })
  await assert.rejects(
    () => bindCapturedGraph(m.session, m.graph, [m.state.snapshot.input]),
    (e) => {
      assert.equal(e.bindingReceipt.invalidatedHandles, 3)
      assert.equal(JSON.stringify(e.bindingReceipt).includes('synthetic-exception-handle'), false)
      return true
    }
  )
})
test('diagnostic usage is after persisted raw, immediately brackets binding including cleanup, never GC/acceptance', async () => {
  const m = mockCdp(),
    receipt = await bindCapturedGraph(m.session, m.graph, [m.state.snapshot.input], {
      phase: 'warm'
    })
  const d = receipt.diagnosticUsage
  assert.equal(d.outsideMeasuredCheckpoint, true)
  assert.equal(d.noGC, true)
  assert.equal(d.noAcceptance, true)
  assert.deepEqual(d.before, { usedSize: 120, totalSize: 300 })
  assert.deepEqual(d.after, { usedSize: 140, totalSize: 300 })
  assert.deepEqual(d.deltas, { usedSize: 20, totalSize: 0 })
  assert.equal(d.callCount, 8)
  assert.equal(d.methodCounts['Runtime.getHeapUsage'], 2)
  assert.equal(d.methods[0].stage, 'before-binding-usage')
  assert.equal(d.methods.at(-1).stage, 'after-binding-usage')
  assert.equal(
    d.methods.some((x) => x.method === 'HeapProfiler.collectGarbage'),
    false
  )
  assert.equal(JSON.stringify(d).includes('remote-'), false)
  assert.equal(
    d.methods.some((x) => x.parameterKeys.includes('functionDeclaration')),
    true
  )
  const f = mockCdp({ returnedException: returnedDetails() })
  await assert.rejects(
    () => bindCapturedGraph(f.session, f.graph, [f.state.snapshot.input]),
    (e) => {
      assert.equal(e.bindingReceipt.diagnosticUsage.callCount, 8)
      assert.equal(e.bindingReceipt.diagnosticUsage.after.usedSize, 140)
      return true
    }
  )
})
for (const mode of [
  'state-handle',
  'snapshot-handle',
  'reader-transport',
  'serialization',
  'before-usage',
  'after-usage',
  'release',
  'invalidation'
])
  test('safe exact binding stage on ' + mode + ' failure', async () => {
    const m = mockCdp(),
      base = m.session.send.bind(m.session)
    let lookups = 0,
      usages = 0
    const expected = {
      'state-handle': 'prefix-state-handle',
      'snapshot-handle': 'prefix-snapshot-handle',
      'reader-transport': 'prefix-state-read',
      serialization: 'prefix-state-read',
      'before-usage': 'before-binding-usage',
      'after-usage': 'after-binding-usage',
      release: 'release-group',
      invalidation: 'invalidate-handle'
    }[mode]
    const session = {
      async send(method, params) {
        if (
          method === 'Runtime.getHeapUsage' &&
          ++usages === (mode === 'before-usage' ? 1 : mode === 'after-usage' ? 2 : -1)
        )
          return { usedSize: NaN, totalSize: 200 }
        if (
          method === 'HeapProfiler.getObjectByHeapObjectId' &&
          ++lookups === (mode === 'state-handle' ? 1 : mode === 'snapshot-handle' ? 2 : -1)
        )
          return { result: {} }
        if (method === 'Runtime.callFunctionOn' && params.arguments?.length) {
          if (mode === 'reader-transport') throw new Error('DO_NOT_PERSIST_TRANSPORT_BODY')
          if (mode === 'serialization') return { result: { type: 'undefined' } }
        }
        if (method === 'Runtime.releaseObjectGroup' && mode === 'release')
          throw new Error('DO_NOT_PERSIST_PERMISSION_BODY')
        if (
          method === 'Runtime.callFunctionOn' &&
          !params.arguments?.length &&
          mode === 'invalidation'
        )
          throw new Error('DO_NOT_PERSIST_DISCONNECT_BODY')
        return base(method, params)
      }
    }
    await assert.rejects(
      () => bindCapturedGraph(session, m.graph, [m.state.snapshot.input]),
      (e) => {
        assert.equal(e.bindingFailure.stage, expected)
        assert.equal(JSON.stringify(e.bindingReceipt).includes('DO_NOT_PERSIST'), false)
        assert.ok(
          e.bindingReceipt.diagnosticUsage.methods.some(
            (x) => x.method === 'Runtime.releaseObjectGroup'
          )
        )
        return true
      }
    )
  })
test('original immutable guards remain semantic reds and data getters are never invoked', async () => {
  for (const mode of [
    'getter',
    'frozen',
    'signature',
    'snapshot',
    'accounting',
    'caps',
    'canonical'
  ]) {
    let touched = 0
    const state = structuredClone(immutablePrefix())
    if (mode === 'getter')
      Object.defineProperty(state.snapshot, 'input', {
        get() {
          touched++
          return 'INJECTED_BODY'
        }
      })
    if (mode === 'signature') state.signature = 'other'
    if (mode === 'accounting') state.snapshot.accounting.nodes = 1
    if (mode === 'caps') state.snapshot.cut = 200000
    const seen = new Set(),
      pending = [state]
    if (mode !== 'frozen')
      while (pending.length) {
        const at = pending.pop()
        if (!at || typeof at !== 'object' || seen.has(at)) continue
        seen.add(at)
        for (const d of Object.values(Object.getOwnPropertyDescriptors(at)))
          if ('value' in d) pending.push(d.value)
        Object.freeze(at)
      }
    const m = mockCdp(),
      base = m.session.send.bind(m.session)
    const session = {
      async send(method, params) {
        if (method === 'Runtime.callFunctionOn' && params.arguments?.length) {
          try {
            return {
              result: {
                value: readBoundPrefix.call(
                  state,
                  mode === 'snapshot' ? immutablePrefix().snapshot : state.snapshot
                )
              }
            }
          } catch (e) {
            return { exceptionDetails: returnedDetails('Error', 'Error: ' + e.message) }
          }
        }
        return base(method, params)
      }
    }
    await assert.rejects(
      () =>
        bindCapturedGraph(session, m.graph, [
          mode === 'canonical' ? 'other canonical' : m.state.snapshot.input
        ]),
      (e) => {
        assert.equal(e.name, 'QualificationSemanticError', mode)
        assert.equal(e.bindingReceipt.released, true)
        assert.equal(e.bindingReceipt.invalidatedHandles, 2)
        return true
      }
    )
    assert.equal(touched, 0)
  }
})

for (const mode of ['__proto__', 'extra', 'hole'])
  test('fresh descriptor copy preserves exact frozen array ' + mode + ' rejection', () => {
    const state = structuredClone(immutablePrefix())
    if (mode === '__proto__')
      Object.defineProperty(state.snapshot.blocks, '__proto__', { value: null, enumerable: true })
    if (mode === 'extra')
      Object.defineProperty(state.snapshot.blocks, 'extra', { value: 1, enumerable: false })
    if (mode === 'hole') delete state.snapshot.blocks[0]
    freezeAll(state)
    assert.throws(
      () => readBoundPrefix.call(state, state.snapshot),
      /invalid immutable prefix binding: array-shape/
    )
  })
for (const separator of [
  '\t',
  '\n',
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
])
  test('owner token scan preserves whitespace U+' + separator.charCodeAt(0).toString(16), () => {
    const { root, fiber } = fiberPair(),
      host = {
        tag: 5,
        memoizedProps: { className: 'chat-view' + separator + 'terminal-view' },
        child: fiber,
        return: root
      }
    root.child = host
    fiber.return = host
    assert.deepEqual(readOwnerFiber.call(fiber).views, ['terminal'])
  })
function syntheticInspectorFixture(mode, className) {
  let calls = 0
  const point = { line: 1, column: 1, offset: 0 },
    snapshot = {
      input: 'ab tail',
      cut: 2,
      line: 1,
      blocks: [{ type: 'paragraph', children: [{ type: 'text', value: 'ab' }] }],
      rootStart: point,
      accounting: {
        blocks: 1,
        nodes: 2,
        sourceSpanCodeUnits: 2,
        astStringCodeUnits: 2,
        sourceBytes: 8
      }
    },
    state = { kind: 'prefix', signature: 'remark-gfm4:singleTilde=true', snapshot }
  if (mode === 'getter')
    Object.defineProperty(snapshot, 'input', {
      get() {
        calls++
        return 'never read'
      }
    })
  if (mode === 'optional-getter')
    Object.defineProperty(snapshot.blocks[0].children[0], 'url', {
      get() {
        calls++
        return 'never read'
      }
    })
  if (mode === '__proto__')
    Object.defineProperty(snapshot.blocks, '__proto__', { value: null, enumerable: true })
  if (mode === 'extra')
    Object.defineProperty(snapshot.blocks, 'extra', { value: 1, enumerable: false })
  if (mode === 'hole') delete snapshot.blocks[0]
  if (mode === 'accounting') snapshot.accounting.nodes = 1
  if (mode === 'signature') state.signature = 'other'
  if (mode === 'caps') snapshot.cut = 200000
  if (mode === 'source-cap') {
    snapshot.input = 'a'.repeat(70000)
    snapshot.blocks = [{ type: 'text', value: 'a'.repeat(65536) }]
    snapshot.accounting = {
      blocks: 1,
      nodes: 1,
      sourceSpanCodeUnits: 2,
      astStringCodeUnits: 65536,
      sourceBytes: 131076
    }
  }
  if (mode === 'block-cap') {
    snapshot.blocks = Array.from({ length: 65 }, () => ({ type: 'paragraph' }))
    snapshot.accounting = {
      blocks: 65,
      nodes: 65,
      sourceSpanCodeUnits: 2,
      astStringCodeUnits: 0,
      sourceBytes: 4
    }
  }
  if (mode === 'node-cap') {
    // 32 valid paragraph blocks, 4,097 total nodes, without a 4,096-wide array
    // dominating the inspector checker. The product's node/block caps stay exact.
    snapshot.blocks = Array.from({ length: 32 }, (_, i) => ({
      type: 'paragraph',
      children: Array.from({ length: i === 0 ? 128 : 127 }, () => ({ type: 'text', value: '' }))
    }))
    snapshot.accounting = {
      blocks: 32,
      nodes: 4097,
      sourceSpanCodeUnits: 2,
      astStringCodeUnits: 0,
      sourceBytes: 4
    }
  }
  if (mode !== 'unfrozen') {
    const seen = new Set(),
      pending = [state]
    while (pending.length) {
      const at = pending.pop()
      if (!at || typeof at !== 'object' || seen.has(at)) continue
      seen.add(at)
      for (const d of Object.values(Object.getOwnPropertyDescriptors(at)))
        if ('value' in d) pending.push(d.value)
      Object.freeze(at)
    }
  }
  const root = { tag: 3, stateNode: {} },
    host = {
      tag: 5,
      memoizedProps: { className, 'data-session-id': 'synthetic-session' },
      return: root
    },
    owner = { tag: 0, return: host },
    alternate = { tag: 0, return: host }
  owner.alternate = alternate
  alternate.alternate = owner
  root.child = host
  host.child = owner
  root.stateNode.current = root
  return { state, snapshot, owner, alternate, getterCalls: () => calls }
}
async function inspectSynthetic(mode = 'valid', className = 'chat-view terminal-view') {
  const session = new inspector.Session(),
    group = 'parser-resource-unit-synthetic',
    handles = [],
    calls = []
  session.connect()
  const post = (method, params) => {
    calls.push({ method, parameterKeys: Object.keys(params).sort() })
    return new Promise((resolve, reject) =>
      session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)))
    )
  }
  const call = async (objectId, fn, args = [], byValue = true) => {
    const params = {
      objectId,
      functionDeclaration: fn.toString(),
      arguments: args,
      returnByValue: byValue,
      silent: true,
      throwOnSideEffect: true,
      objectGroup: group
    }
    assert.equal(params.throwOnSideEffect, true)
    assert.equal(params.returnByValue, byValue)
    assert.equal(params.objectGroup, group)
    const result = await post('Runtime.callFunctionOn', params)
    for (const id of [result.result?.objectId, result.exceptionDetails?.exception?.objectId])
      if (id && !handles.includes(id)) handles.push(id)
    return result
  }
  const release = async () => {
    await post('Runtime.releaseObjectGroup', { objectGroup: group })
    released = true
    for (const objectId of handles) {
      let invalid = false
      try {
        await post('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(){return 1}',
          returnByValue: true,
          silent: true,
          throwOnSideEffect: true
        })
      } catch (error) {
        if (/Could not find object with given id/.test(String(error))) invalid = true
        else throw error
      }
      assert.ok(invalid, 'local synthetic handle remained usable')
      invalidated++
    }
  }
  let result,
    released = false,
    invalidated = 0,
    disconnected = false
  try {
    const setup = await post('Runtime.evaluate', {
      expression:
        '(' +
        syntheticInspectorFixture.toString() +
        ')(' +
        JSON.stringify(mode) +
        ',' +
        JSON.stringify(className) +
        ')',
      returnByValue: false,
      objectGroup: group,
      silent: true
    })
    assert.equal(setup.exceptionDetails, undefined)
    handles.push(setup.result.objectId)
    const state = (
        await call(
          handles[0],
          function () {
            return this.state
          },
          [],
          false
        )
      ).result.objectId,
      snapshot = (
        await call(
          handles[0],
          function () {
            return this.snapshot
          },
          [],
          false
        )
      ).result.objectId
    const read = await call(state, readBoundPrefix, [{ objectId: snapshot }])
    result = {
      node: process.version,
      v8: process.versions.v8,
      syntheticOnly: true,
      qualifiedElectron: false,
      prefix: read.exceptionDetails
        ? { success: false, protocol: sanitizeExceptionDetails(read.exceptionDetails) }
        : { success: true, value: read.result.value }
    }
    if (result.prefix.success) {
      try {
        if (mode === 'valid')
          assert.ok(result.prefix.value.input === 'ab tail', 'synthetic input mismatch')
      } finally {
        delete result.prefix.value.input
      }
    }
    result.getterCalls = (
      await call(handles[0], function () {
        return this.getterCalls()
      })
    ).result.value
    if (mode === 'valid') {
      result.owners = []
      for (const field of ['owner', 'alternate']) {
        const fn =
            field === 'owner'
              ? function () {
                  return this.owner
                }
              : function () {
                  return this.alternate
                },
          id = (await call(handles[0], fn, [], false)).result.objectId
        const owner = await call(id, readOwnerFiber)
        result.owners.push(
          owner.exceptionDetails
            ? { success: false, protocol: sanitizeExceptionDetails(owner.exceptionDetails) }
            : { success: true, value: owner.result.value }
        )
      }
    }
  } finally {
    try {
      await release()
    } finally {
      session.disconnect()
      disconnected = true
    }
  }
  return { ...result, cleanup: { released, invalidated, disconnected }, calls }
}
test('real local Node inspector runs actual prefix and current/alternate readers with checker true', async () => {
  const result = await inspectSynthetic()
  assert.equal(result.prefix.success, true, JSON.stringify(result.prefix.protocol))
  assert.equal(result.prefix.value.deepFrozen, true)
  assert.equal(result.prefix.value.accounting.nodes, 2)
  assert.deepEqual(
    result.owners.map((x) => x.success),
    [true, true]
  )
  assert.deepEqual(
    result.owners.map((x) => x.value.branch),
    ['current', 'alternate']
  )
  assert.deepEqual(result.owners[0].value.views, ['terminal'])
  assert.equal(result.cleanup.released, true)
  assert.equal(result.cleanup.disconnected, true)
  assert.ok(result.cleanup.invalidated >= 5)
  assert.equal(
    result.calls.some((c) => c.method.startsWith('HeapProfiler.')),
    false
  )
  assert.equal(result.qualifiedElectron, false)
})
for (const mode of [
  'getter',
  'optional-getter',
  'unfrozen',
  'signature',
  'accounting',
  'caps',
  'source-cap',
  'block-cap',
  '__proto__',
  'extra',
  'hole'
])
  test(
    'real Node checker keeps ' + mode + ' validation semantic and cleans every local handle',
    async () => {
      const result = await inspectSynthetic(mode)
      assert.equal(result.prefix.success, false)
      assert.equal(result.prefix.protocol.exception.className, 'Error')
      assert.match(
        result.prefix.protocol.exception.description,
        /^Error: invalid immutable prefix binding/
      )
      assert.equal(result.getterCalls, 0)
      assert.equal(result.cleanup.released, true)
      assert.equal(result.cleanup.disconnected, true)
      assert.ok(result.cleanup.invalidated >= 3)
    }
  )
for (const [className, expected] of [
  ['xterminal-view chat-viewer', []],
  ['terminal-viewer chat-view', ['chat']],
  ['chat-view\u00a0terminal-view', ['terminal']],
  ['chat-view\u180eterminal-view', []]
])
  test('real Node owner exact token boundary ' + JSON.stringify(className), async () => {
    const result = await inspectSynthetic('valid', className)
    assert.ok(result.owners.every((x) => x.success))
    assert.deepEqual(result.owners[0].value.views, expected)
  })

test('real Node inspector rejects an external write to a fresh synthetic sentinel', async () => {
  const session = new inspector.Session(),
    group = 'parser-resource-unit-write-negative'
  session.connect()
  const post = (method, params) =>
    new Promise((resolve, reject) =>
      session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)))
    )
  let objectId
  try {
    const setup = await post('Runtime.evaluate', {
      expression: '({counter:0})',
      objectGroup: group,
      returnByValue: false,
      silent: true
    })
    objectId = setup.result.objectId
    const rejected = await post('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){this.counter++;return this.counter}',
      objectGroup: group,
      returnByValue: true,
      silent: true,
      throwOnSideEffect: true
    })
    assert.equal(
      sanitizeExceptionDetails(rejected.exceptionDetails).exception.className,
      'EvalError'
    )
    const read = await post('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){return this.counter}',
      objectGroup: group,
      returnByValue: true,
      silent: true,
      throwOnSideEffect: true
    })
    assert.equal(read.exceptionDetails, undefined)
    assert.equal(read.result.value, 0)
  } finally {
    try {
      await post('Runtime.releaseObjectGroup', { objectGroup: group })
      if (objectId)
        await assert.rejects(
          () =>
            post('Runtime.callFunctionOn', {
              objectId,
              functionDeclaration: 'function(){return 1}',
              returnByValue: true,
              silent: true,
              throwOnSideEffect: true
            }),
          /Could not find object with given id/
        )
    } finally {
      session.disconnect()
    }
  }
})

// The full VM checker case is a separate standalone synthetic proof. Walking
// 4,097 nodes in the debugger is costly under parallel unit-worker load; this
// direct assertion still enforces the exact node cap on every ordinary run.
test('exact 4097-node immutable budget fails the actual reader guard', () => {
  const { state, snapshot } = syntheticInspectorFixture('node-cap', 'chat-view')
  assert.equal(snapshot.accounting.blocks, 32)
  assert.equal(snapshot.accounting.nodes, 4097)
  assert.throws(
    () => readBoundPrefix.call(state, snapshot),
    /invalid immutable prefix binding: node-cap/
  )
})
