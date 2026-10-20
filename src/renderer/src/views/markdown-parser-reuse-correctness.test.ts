import { compareDeep } from './markdown-parser-deep-test-support'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { LONG_RESPONSE, streamChunk } from '../../../../tests/e2e/renderer-workload.mjs'
import {
  createMarkdownAttempt,
  createMarkdownStore,
  sameCommittedMarkdown,
  type CommittedMarkdown,
  type MarkdownTree,
  type MarkdownFile,
  type MarkdownProcessor,
  type MarkdownAttempt
} from '../../../../plugins/chat-view/src/markdown-parser-reuse'

interface MarkdownSlot {
  current: CommittedMarkdown | undefined
}
type Entry = { length: number; fullLength: number; sameFile: boolean }
function render(
  input: string,
  slot: MarkdownSlot | undefined,
  options: {
    final?: boolean
    signature?: string
    singleTilde?: boolean
    commit?: boolean
    mutate?: (tree: MarkdownTree) => void
    error?: Error
  } = {}
): {
  tree: MarkdownTree
  html: string
  urls: string[]
  entries: Entry[]
  attempt?: MarkdownAttempt
} {
  const entries: Entry[] = [],
    files: MarkdownFile[] = [],
    urls: string[] = []
  const attempt =
    slot &&
    createMarkdownAttempt(
      slot.current,
      input,
      options.final ?? false,
      options.signature ?? 'default'
    )
  let tree: MarkdownTree | undefined, downstreamFile: MarkdownFile | undefined
  function instrument(this: MarkdownProcessor): void {
    const original = this.parser
    if (!original) throw new Error('Original parser probe did not attach')
    this.parser = (document, file) => {
      entries.push({
        length: document.length,
        fullLength: String(file.value).length,
        sameFile: false
      })
      files.push(file)
      if (options.error) throw options.error
      return original(document, file)
    }
  }
  function collect(): (value: MarkdownTree, file: MarkdownFile) => void {
    return (value, file) => {
      tree = value
      downstreamFile = file
      options.mutate?.(value)
    }
  }
  const plugins: NonNullable<Options['remarkPlugins']> = [
    [remarkGfm, { singleTilde: options.singleTilde ?? true }],
    instrument,
    ...(attempt ? [attempt.plugin] : []),
    collect
  ]
  const html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: plugins,
        urlTransform: (url) => {
          const safe = defaultUrlTransform(url)
          urls.push(url + ' => ' + safe)
          return safe
        }
      },
      input
    )
  )
  expect(entries.length).toBeGreaterThan(0)
  entries.forEach((entry, i) => {
    entry.sameFile = files[i] === downstreamFile
    expect(entry.sameFile).toBe(true)
    expect(entry.fullLength).toBe(input.length)
  })
  if (!tree) throw new Error('Full tree collector did not enter')
  if (slot && attempt && options.commit !== false && attempt.ready()) {
    slot.current = attempt.candidate()
    attempt.release()
  }
  return { tree, html, urls, entries, attempt }
}
function compare(
  input: string,
  slot: MarkdownSlot,
  options: Parameters<typeof render>[2] = {}
): ReturnType<typeof render> {
  const full = render(input, undefined, options)
  const reused = render(input, slot, options)
  expect(reused.tree, 'complete document tree/position parity: ' + input).toEqual(full.tree)
  expect(reused.html, input).toBe(full.html)
  expect(reused.urls, input).toEqual(full.urls)
  return reused
}
const makeSlot = (): MarkdownSlot => ({ current: undefined })
function freezeDeep(value: unknown): void {
  const pending = [value]
  while (pending.length) {
    const n = pending.pop()
    if (typeof n !== 'object' || n === null || Object.isFrozen(n)) continue
    pending.push(...Object.values(n))
    Object.freeze(n)
  }
}

it('positively observes a complete full entry, then an actual tail and tail-then-full context invalidation', () => {
  const slot = makeSlot(),
    initial = '# Notes\n\nA complete paragraph with [late][x].\n\nMutable'
  expect(compare(initial, slot).entries.map((e) => e.length)).toEqual([initial.length])
  if (slot.current?.kind !== 'prefix') throw new Error('Initial candidate did not enter')
  const cut = slot.current.snapshot.cut,
    next = initial + ' text'
  expect(compare(next, slot).entries.map((e) => e.length)).toEqual([next.length - cut])
  console.log(
    JSON.stringify({
      precondition: 'global-invalidation',
      cut,
      priorTail: next.length - cut,
      currentKind: slot.current?.kind
    })
  )
  const global = next + '\n\n[x]: https://example.org/late'
  const changed = compare(global, slot)
  expect(changed.entries.map((e) => e.length)).toEqual([global.length - cut, global.length])
  expect(changed.html).toContain('href="https://example.org/late"')
  expect(slot.current?.kind).toBe('full')
  const after = global + '\n\nMore'
  expect(compare(after, slot).entries.map((e) => e.length)).toEqual([after.length])
  console.log(
    JSON.stringify({
      proof: 'entered-full-tail-invalidated',
      initial: initial.length,
      cut,
      tail: next.length - cut,
      invalidation: changed.entries,
      followingFull: after.length
    })
  )
})

const corpus = [
  [
    'ordinary',
    '# Notes\n\nAn **ordinary** paragraph and [link](https://example.org "t").\n\nA growing tail with *emphasis* and ~~delete~~.'
  ],
  ['setext-table', 'Earlier\n\nMutable heading\n===\n\n| left | right |\n| --- | --- |\n| a | b |'],
  [
    'incomplete-inline',
    'Earlier\n\nThe **bold *nested* text** uses `code`, \\*escaped\\*, [a](https://example.org/path "title") and ![image](/a.png "alt").'
  ],
  [
    'late-reference',
    '[first][x] and ![picture][img].\n\nMutable\n\n[x]: https://example.org/one\n[x]: https://example.org/two\n[img]: /pic "Title"'
  ],
  ['footnotes', 'A[^n] and B[^n].\n\nMutable\n\n[^n]: Note\n\nAnother[^m].\n\n[^m]: Two'],
  [
    'lists-fences',
    'Earlier\n\n- a\n  - nested\n\n- loose\n\n1. ordered\n2. next\n\n- [x] task\n\n```ts\nconst x = 1\n```\n\n    indented'
  ],
  [
    'quotes-html',
    'Earlier\n\n> quote\n>\n> nested **text**\n\n<div>raw</div>\n\n<span>inline</span>'
  ],
  [
    'urls-brackets',
    'Earlier\n\nhttps://example.org www.example.org a@b.com [safe](/a) [bad](javascript:alert%281%29) [open [nested] literal] \\[escaped\\]'
  ],
  ['lf-unicode', '  Heading 😀\n\nFirst café é.\n\n  Tail\twith\u0000null.\n\nThe end'],
  ['cr', 'Head\r\rFirst\r\r  Tail\rNext\r'],
  ['crlf', '\uFEFFHead\r\n\r\nFirst 😀\r\n\r\n  Tail\r\nNext\r\n'],
  ['mid-bom', 'Head\n\nFirst\n\n\uFEFFTail\n\nNext'],
  ['long-paragraph', 'word '.repeat(100) + '\n\nlast'],
  ['empty', '']
] as const

describe('every-prefix and varied chunk boundary parity against the unchanged full pipeline', () => {
  it.each(corpus)('%s', (name, input) => {
    let entries = 0,
      tails = 0
    for (const step of [1, 2, 7, 31]) {
      const slot = makeSlot()
      for (let end = 0; end <= input.length; end = Math.min(input.length, end + step)) {
        const result = compare(input.slice(0, end), slot)
        entries += result.entries.length
        tails += result.entries.filter((e) => e.length < e.fullLength).length
        if (end === input.length) break
      }
    }
    console.log(
      JSON.stringify({ corpus: name, codeUnits: input.length, entries, tailEntries: tails })
    )
  })
})

it('keeps leading BOM input full-only because parser offsets exclude its first code unit', () => {
  const slot = makeSlot(),
    initial = '\uFEFFHead\r\n\r\nFirst 😀\r\n\r\n  Tail'
  compare(initial, slot)
  expect(slot.current?.kind).toBe('full')
  const next = initial + '\r\nNext\r\n'
  const result = compare(next, slot)
  expect(result.entries.map((e) => e.length)).toEqual([next.length])
  console.log(
    JSON.stringify({
      proof: 'leading-BOM-full-only',
      inputLength: next.length,
      entries: result.entries
    })
  )
})

it('rebases all positioned descendants from the mutable source LINE start', () => {
  const slot = makeSlot(),
    initial = '# Café 😀\r\n\r\nFirst [link](https://example.org).\r\n\r\n  Mutable'
  compare(initial, slot)
  if (slot.current?.kind !== 'prefix') throw new Error('Position fixture did not qualify')
  const cut = slot.current.snapshot.cut
  expect(initial.slice(cut)).toBe('  Mutable')
  const next = initial + ' **strong**\r\n\r\nNext https://example.org'
  const result = compare(next, slot)
  expect(result.entries).toHaveLength(1)
  expect(result.entries[0].length).toBe(next.length - cut)
  console.log(JSON.stringify({ proof: 'rebase-parity', entries: result.entries }))
})

it('isolates retained descendants and positions from downstream mutations', () => {
  const slot = makeSlot(),
    initial = '# Head\n\nA **strong** [link](https://example.org).\n\nMutable'
  compare(initial, slot)
  const saved = slot.current
  if (saved?.kind !== 'prefix') throw new Error('Clone precondition missing')
  const before = JSON.stringify(saved)
  freezeDeep(saved)
  render(initial + ' append', slot, {
    commit: false,
    mutate: (tree) => {
      if (!('children' in tree) || !Array.isArray(tree.children))
        throw new Error('No returned children')
      const first = tree.children[0]
      first.children[0].value = 'downstream changed text'
      first.position.start.line = 99
      first.children[0].position.start.offset = 999
    }
  })
  expect(JSON.stringify(saved)).toBe(before)
  expect(slot.current).toBe(saved)
  compare(initial + ' clean', slot)
})

it('uses complete fallback at caps, finalization and replacement, with no predecessor state', () => {
  const slot = makeSlot(),
    initial = 'a'.repeat(32767) + '\n\ntail'
  compare(initial, slot)
  expect(slot.current?.kind).toBe('prefix')
  const over = initial + '\n\nextra'
  const result = compare(over, slot)
  expect(result.entries.at(-1)?.length).toBe(over.length)
  expect(slot.current?.kind).toBe('full')
  if (slot.current?.kind === 'full')
    expect(Object.keys(slot.current).sort()).toEqual(['blocked', 'input', 'kind', 'signature'])
  compare('replacement\n\nnew tail', slot)
  expect(slot.current?.kind).toBe('prefix')
  compare('replacement\n\nnew tail', slot, { final: true })
  expect(slot.current).toBeUndefined()
})

it('propagates the original parser error and cannot publish a failed attempt', () => {
  const slot = makeSlot(),
    initial = 'First\n\nMutable'
  compare(initial, slot)
  const saved = slot.current,
    attempt = createMarkdownAttempt(slot.current, initial + ' append', false, 'default')
  const error = new Error('original parser sentinel')
  function throwing(this: MarkdownProcessor): void {
    this.parser = () => {
      throw error
    }
  }
  expect(() =>
    renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm, throwing, attempt.plugin] },
        initial + ' append'
      )
    )
  ).toThrow(error)
  if (attempt.ready()) slot.current = attempt.candidate()
  attempt.release()
  expect(slot.current).toBe(saved)
})

it('does not add a deep phrasing inspection/clone failure to accepted full-pipeline input', () => {
  for (const depth of [16, 64, 128, 256]) {
    const text = '*a **b '.repeat(depth) + 'middle' + ' b** a*'.repeat(depth) + '\n\nMutable'
    const slot = makeSlot()
    compareDeep(text, slot, depth, 'initial')
    compareDeep(text + ' grows', slot, depth, 'append')
  }
})

it('actually reuses the workload prefix through a substantial sequence with one bounded current state', () => {
  const slot = makeSlot()
  let input = LONG_RESPONSE
  compare(input, slot)
  let tails = 0
  for (let n = 0; n < 120; n++) {
    input += streamChunk(n)
    const result = compare(input, slot)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].length).toBeLessThan(input.length)
    tails++
    expect(slot.current?.kind).toBe('prefix')
    if (slot.current?.kind === 'prefix') {
      expect(slot.current.snapshot.accounting.sourceBytes).toBeLessThanOrEqual(131072)
      expect(slot.current.snapshot.accounting.nodes).toBeLessThanOrEqual(4096)
      expect(Object.keys(slot.current).sort()).toEqual(['kind', 'signature', 'snapshot'])
    }
  }
  console.log(
    JSON.stringify({
      proof: 'workload-reuse',
      appends: 120,
      tails,
      finalInputLength: input.length,
      accounting: slot.current?.kind === 'prefix' ? slot.current.snapshot.accounting : null
    })
  )
}, 30_000)

it('accepts original-renderer wide phrasing before bounded full fallback without spread inspection', () => {
  const input = '**x** '.repeat(6000) + '\n\nMutable'
  const original = render(input, undefined)
  expect(original.html.match(/<strong>/g)).toHaveLength(6000)
  const slot = makeSlot()
  const wrapped = compare(input, slot)
  expect(wrapped.entries.map((e) => e.length)).toEqual([input.length])
  expect(slot.current?.kind).toBe('full')
  compare(input + ' append', slot)
  console.log(
    JSON.stringify({
      proof: 'original-accepted-width',
      strongNodes: 6000,
      inputLength: input.length,
      fullOnly: slot.current?.kind
    })
  )
}, 30_000)

it('publishes immutable cached snapshots with complete equality and real unsubscribe', () => {
  const slot = makeSlot()
  compare('# Head\n\nA **strong** [link](https://example.org "title").\n\nTail', slot)
  const first = slot.current
  if (first?.kind !== 'prefix') throw new Error('Equality prefix precondition missing')
  const store = createMarkdownStore()
  let notifications = 0
  const unsubscribe = store.subscribe(() => notifications++)
  store.publish(first)
  expect(notifications).toBe(1)
  expect(Object.isFrozen(first.snapshot.blocks[1].children)).toBe(true)
  expect(store.getSnapshot()).toBe(first)
  store.publish(structuredClone(first))
  expect(store.getSnapshot()).toBe(first)
  expect(notifications).toBe(1)
  const changes: Array<(copy: Extract<CommittedMarkdown, { kind: 'prefix' }>) => void> = [
    (v) => {
      v.signature += 'changed'
    },
    (v) => {
      v.snapshot.input += 'changed'
    },
    (v) => {
      v.snapshot.cut++
    },
    (v) => {
      v.snapshot.line++
    },
    (v) => {
      v.snapshot.rootStart.column++
    },
    (v) => {
      v.snapshot.accounting.sourceBytes++
    },
    (v) => {
      v.snapshot.blocks[0].depth = 2
    },
    (v) => {
      v.snapshot.blocks[0].position!.end.offset++
    },
    (v) => {
      v.snapshot.blocks[0].children![0].value += 'changed'
    },
    (v) => {
      v.snapshot.blocks.pop()
    },
    (v) => {
      v.snapshot.blocks[0].children = []
    }
  ]
  for (const change of changes) {
    const copy = structuredClone(first)
    change(copy)
    expect(sameCommittedMarkdown(first, copy)).toBe(false)
    store.publish(copy)
    expect(store.getSnapshot()).toBe(copy)
    store.publish(first)
  }
  const full: CommittedMarkdown = {
    kind: 'full',
    signature: first.signature,
    input: first.snapshot.input,
    blocked: false
  }
  expect(sameCommittedMarkdown(first, full)).toBe(false)
  expect(sameCommittedMarkdown(full, { ...full })).toBe(true)
  expect(sameCommittedMarkdown(full, { ...full, blocked: true })).toBe(false)
  expect(sameCommittedMarkdown(full, { ...full, input: full.input + 'x' })).toBe(false)
  expect(sameCommittedMarkdown(full, { ...full, signature: 'other' })).toBe(false)
  store.publish(full)
  store.clear()
  expect(store.getSnapshot()).toBeUndefined()
  const clearedCount = notifications
  store.clear()
  expect(notifications).toBe(clearedCount)
  unsubscribe()
  store.publish(first)
  expect(notifications).toBe(clearedCount)
  store.clear()
  expect(store.getSnapshot()).toBeUndefined()
})

it('clones promoted nested descendants before any downstream transform can mutate them', () => {
  const slot = makeSlot(),
    input = '# Head\n\nA **strong** paragraph.\n\nMutable'
  let entered = false
  render(input, slot, {
    mutate: (tree) => {
      if (!('children' in tree) || !Array.isArray(tree.children)) throw new Error('No mutable tree')
      entered = true
      tree.children[0].children[0].value = 'changed downstream'
      tree.children[0].position.start.line = 99
    }
  })
  expect(entered).toBe(true)
  if (slot.current?.kind !== 'prefix') throw new Error('Promotion precondition missing')
  expect(
    slot.current.snapshot.blocks[0].children![0].value,
    'promoted text is isolated from downstream mutation'
  ).toBe('Head')
  expect(
    slot.current.snapshot.blocks[0].position!.start.line,
    'promoted positions are isolated'
  ).toBe(1)
  compare(input + ' append', slot)
})
