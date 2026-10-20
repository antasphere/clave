// Functional fixture for the UNUSED actual component. Observers are injected
// into its compiled bundle by the spec, never exposed by production exports.
import React, { StrictMode, Suspense, startTransition } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MarkdownMessage } from '../../../diagnostics/prefix-cache/plugins/chat-view/src/MarkdownMessage'

const probe = {
  phase: 'idle',
  stores: [],
  owners: [],
  attempts: [],
  entries: [],
  publications: [],
  effects: [],
  listeners: [],
  suspensions: [],
  caught: [],
  errors: [],
  expected: {},
  throwInput: null
}
const ids = new WeakMap()
let nextId = 1
const identity = (value) => {
  if (!value) return null
  if (!ids.has(value)) ids.set(value, nextId++)
  return ids.get(value)
}
const inputOf = (value) =>
  value?.kind === 'prefix' ? value.snapshot.input : (value?.input ?? null)
const root = createRoot(document.getElementById('root'), {
  onCaughtError: (error) => probe.caught.push(error.message),
  onUncaughtError: (error) => probe.errors.push(error.message)
})
let blocked, gate, release
const domOf = (row) => document.querySelector(`[data-row="${row}"]`)?.innerHTML ?? null
const rowOf = (input) => (input === probe.expected.two ? 'two' : 'one')
const storeOf = (store) => {
  const result = probe.stores.find((s) => s.store === store)
  if (!result) throw new Error('Unregistered real store')
  return result
}
globalThis.__markdownProbe = {
  created(store, count) {
    probe.stores.push({ id: identity(store), store, count, row: null })
  },
  owner(store, input, base) {
    storeOf(store).row = rowOf(input)
    probe.owners.push({
      row: rowOf(input),
      input,
      base: inputOf(base),
      baseId: identity(base),
      phase: probe.phase
    })
    if (probe.owners.length > 400) throw new Error('Real Markdown notification loop')
  },
  attempt(attempt, input, base) {
    probe.attempts.push({
      id: identity(attempt),
      row: rowOf(input),
      input,
      base: inputOf(base),
      baseId: identity(base),
      released: false,
      phase: probe.phase
    })
  },
  entry(attempt, document, file) {
    const a = probe.attempts.find((x) => x.id === identity(attempt))
    if (!a) throw new Error('Unregistered real parser attempt')
    probe.entries.push({
      attemptId: a.id,
      input: a.input,
      row: a.row,
      base: a.base,
      baseId: a.baseId,
      length: document.length,
      fullLength: String(file.value).length,
      sameFile: false,
      file,
      phase: probe.phase
    })
    if (probe.throwInput === a.input) throw new Error('actual configured parser sentinel')
  },
  collect(attempt, tree, file) {
    const entries = probe.entries.filter((e) => e.attemptId === identity(attempt))
    if (!entries.length) throw new Error('Collector missed actual configured parser')
    for (const entry of entries) entry.sameFile = entry.sameFile || entry.file === file
    const a = probe.attempts.find((x) => x.id === identity(attempt))
    a.rootType = tree.type
  },
  effect(attempt, store) {
    const a = probe.attempts.find((x) => x.id === identity(attempt))
    probe.effects.push({
      attemptId: a.id,
      input: a.input,
      ready: attempt.ready(),
      candidateId: identity(attempt.candidate()),
      storeId: identity(store),
      phase: probe.phase
    })
  },
  released(attempt) {
    probe.attempts.find((a) => a.id === identity(attempt)).released = true
  },
  published(store, value) {
    const s = storeOf(store)
    probe.publications.push({
      storeId: s.id,
      row: s.row,
      input: inputOf(value),
      snapshotId: identity(value),
      kind: value?.kind ?? 'final',
      blocked: value?.kind === 'full' ? value.blocked : null,
      dom: domOf(s.row),
      options: s.row === 'two' ? {} : probe.options,
      phase: probe.phase
    })
  },
  subscribed(store, count) {
    probe.listeners.push({ storeId: identity(store), count, phase: probe.phase })
  }
}
class Boundary extends React.Component {
  static propTypes = {
    children: (props, key) => (key in props ? null : new Error('Boundary requires children'))
  }
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed
      ? React.createElement('p', { 'data-error': true }, 'caught')
      : this.props.children
  }
}
function AfterParser({ input }) {
  if (blocked === input) {
    probe.suspensions.push({ input, phase: probe.phase })
    throw gate
  }
  return null
}
AfterParser.propTypes = {
  input: (props, key) => (typeof props[key] === 'string' ? null : new Error('input required'))
}
const maps = {
  default: undefined,
  alternate: { p: ({ children }) => React.createElement('p', { 'data-custom': 'yes' }, children) },
  error: {
    p: () => {
      throw new Error('downstream component sentinel')
    }
  }
}
function view(
  input,
  { final = false, singleTilde = true, second = null, map = 'default', boundary = 'stable' } = {}
) {
  const rows = [
    React.createElement(
      'section',
      { key: 'one', 'data-row': 'one' },
      React.createElement(MarkdownMessage, { final, singleTilde, components: maps[map] }, input)
    )
  ]
  if (second !== null)
    rows.push(
      React.createElement(
        'section',
        { key: 'two', 'data-row': 'two' },
        React.createElement(MarkdownMessage, { final: false }, second)
      )
    )
  return React.createElement(
    StrictMode,
    null,
    React.createElement(
      Boundary,
      { key: boundary },
      React.createElement(
        Suspense,
        { fallback: React.createElement('p', { 'data-fallback': true }, 'pending') },
        ...rows,
        React.createElement(AfterParser, { input })
      )
    )
  )
}
window.markdownFixture = {
  render(input, options = {}) {
    globalThis.__markdownProbe.forceParserRetry = Boolean(options.forceParserRetry)
    probe.phase = options.phase || input
    probe.expected = { one: input, two: options.second }
    probe.options = { singleTilde: options.singleTilde ?? true, map: options.map ?? 'default' }
    probe.throwInput = options.parserError ? input : null
    if (options.suspend) {
      blocked = input
      gate = new Promise((done) => {
        release = done
      })
    }
    const next = view(input, options)
    if (options.transition) startTransition(() => root.render(next))
    else flushSync(() => root.render(next))
  },
  oracle(input, { singleTilde = true, map = 'default' } = {}) {
    return renderToStaticMarkup(
      React.createElement(
        ReactMarkdown,
        { remarkPlugins: [[remarkGfm, { singleTilde }]], components: maps[map] },
        input
      )
    )
  },
  release() {
    blocked = null
    release?.()
    release = null
    gate = null
  },
  unmount() {
    probe.phase = 'unmount'
    flushSync(() => root.render(null))
  },
  finish() {
    probe.phase = 'finish'
    flushSync(() => root.unmount())
  },
  snapshot() {
    return {
      ...probe,
      entries: probe.entries.map((entry) => ({ ...entry, file: undefined })),
      stores: probe.stores.map(({ id, store, count, row }) => {
        const s = store.getSnapshot()
        return {
          id,
          row,
          snapshotId: identity(s),
          input: inputOf(s),
          kind: s?.kind ?? 'final',
          cached: Object.is(s, store.getSnapshot()),
          listeners: count(),
          accounting: s?.kind === 'prefix' ? s.snapshot.accounting : null,
          keys: s ? Object.keys(s).sort() : []
        }
      }),
      dom: { one: domOf('one'), two: domOf('two') },
      urls: Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    }
  }
}
