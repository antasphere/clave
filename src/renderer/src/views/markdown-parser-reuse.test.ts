import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { LONG_RESPONSE, streamChunk } from '../../../../tests/e2e/renderer-workload.mjs'
import {
  markdownParserBoundary,
  inspectParserPrefix,
  accountPrefix,
  PREFIX_LIMITS,
  type MarkdownProcessor,
  type MarkdownTree,
  type MarkdownFile,
  type PrefixInspection
} from '../../../../tests/diagnostics/prefix-cache/plugins/chat-view/src/markdown-parser-reuse'

type ParseEntry = { length: number; file: MarkdownFile; tree: MarkdownTree }
const components: Components = {
  a: ({ href, children }) =>
    createElement('a', { href, 'data-original-component': 'link' }, children),
  table: ({ children }) => createElement('table', { 'data-original-component': 'table' }, children)
}
function pipeline(
  input: string,
  wrapped: boolean,
  final = false
): {
  html: string
  tree: MarkdownTree
  inspection?: PrefixInspection
  urls: Array<{ url: string; key: string; safe: string }>
} {
  const entries: ParseEntry[] = [],
    boundaries: ParseEntry[] = []
  let returnedTree: MarkdownTree | undefined, downstreamFile: MarkdownFile | undefined
  let inspection: PrefixInspection | undefined,
    attached = 0,
    configuredGfm = false
  // This probe is BELOW the adapter. Its counter cannot pass when the adapter
  // fails to enter its captured configured parser. It then invokes remarkParse.
  function originalEntry(this: MarkdownProcessor): void {
    const original = this.parser
    if (!original) throw new Error('Original configured parser missing')
    const data: unknown = this.data()
    configuredGfm =
      typeof data === 'object' &&
      data !== null &&
      'micromarkExtensions' in data &&
      Array.isArray(data.micromarkExtensions) &&
      data.micromarkExtensions.length > 0
    this.parser = (document, file) => {
      const entry = { length: document.length, file, tree: original(document, file) }
      entries.push(entry)
      return entry.tree
    }
  }
  const boundary = markdownParserBoundary((document, file, tree) => {
    boundaries.push({ length: document.length, file, tree })
    inspection = inspectParserPrefix(document, tree, final)
  })
  function afterParse(this: MarkdownProcessor): (tree: MarkdownTree, file: MarkdownFile) => void {
    attached++
    return (tree, file) => {
      returnedTree = tree
      downstreamFile = file
    }
  }
  const plugins: NonNullable<Options['remarkPlugins']> = [remarkGfm, originalEntry]
  if (wrapped) plugins.push(boundary)
  plugins.push(afterParse)
  const urls: Array<{ url: string; key: string; safe: string }> = []
  const html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: plugins,
        components,
        urlTransform: (url, key) => {
          const safe = defaultUrlTransform(url)
          urls.push({ url, key, safe })
          return safe
        }
      },
      input
    )
  )
  expect(configuredGfm).toBe(true)
  expect(attached).toBe(1)
  expect(entries).toHaveLength(1)
  expect(entries.map((entry) => entry.length)).toEqual([input.length])
  expect(entries[0].file.value).toBe(input)
  expect(entries[0].file).toBe(downstreamFile)
  expect(entries[0].tree).toBe(returnedTree)
  expect(boundaries).toHaveLength(wrapped ? 1 : 0)
  if (wrapped) {
    expect(boundaries[0].length).toBe(input.length)
    expect(boundaries[0].file).toBe(entries[0].file)
    expect(boundaries[0].tree).toBe(entries[0].tree)
    expect(inspection).toBeDefined()
  }
  if (!returnedTree) throw new Error('Full returned tree was not observed')
  console.log(
    JSON.stringify({
      proof: 'original-parser-entry',
      wrapped,
      entries: entries.length,
      inputLengths: entries.map((entry) => entry.length),
      fullFileCodeUnits: String(entries[0].file.value).length,
      sameFullFile: entries[0].file === downstreamFile,
      sameFullTree: entries[0].tree === returnedTree,
      boundaryEntered: boundaries.length
    })
  )
  return { html, tree: returnedTree, inspection, urls }
}
function parity(input: string, final = false): PrefixInspection {
  const baseline = pipeline(input, false),
    wrapped = pipeline(input, true, final)
  expect(wrapped.tree).toEqual(baseline.tree)
  expect(wrapped.html).toBe(baseline.html)
  expect(wrapped.urls).toEqual(baseline.urls)
  // The native callsites use the default URL policy. Delegating through our
  // trace callback must have exactly its unchanged output as well.
  expect(wrapped.html).toBe(
    renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        {
          remarkPlugins: [remarkGfm],
          components
        },
        input
      )
    )
  )
  if (!wrapped.inspection) throw new Error('Inspection did not enter')
  return wrapped.inspection
}

describe('unused public Markdown parser boundary', () => {
  it('enters the actual configured parser and forwards its full tree/file unchanged', () => {
    const input =
      '# Notes\n\nAn ordinary **strong** paragraph with [a link](https://example.org/a "Title").\n\nMutable tail'
    const result = parity(input)
    expect(result.kind).toBe('candidate')
    if (result.kind !== 'candidate') throw new Error('Ordinary prose did not qualify')
    expect(result.snapshot.input).toBe(input)
    expect(result.snapshot.cut).toBe(input.indexOf('Mutable'))
    expect(result.accounting.blocks).toBe(2)
    expect(accountPrefix(result.snapshot.blocks, result.snapshot.cut)).toEqual(result.accounting)
    const actual = pipeline(input, true)
    const owned = actual.inspection
    if (
      owned?.kind !== 'candidate' ||
      !('children' in actual.tree) ||
      !Array.isArray(actual.tree.children)
    )
      throw new Error('Owned prefix/full tree were not observed')
    expect(owned.snapshot.blocks[0]).not.toBe(actual.tree.children[0])
    const saved = structuredClone(owned.snapshot.blocks)
    Object.assign(actual.tree.children[0], { downstreamMutation: 'must not reach snapshot' })
    expect(owned.snapshot.blocks).toEqual(saved)
  })

  it('keeps GFM and URL/HTML policy in the original complete renderer pipeline', () => {
    const input =
      '~~gone~~ and https://example.org and www.example.org\n\n' +
      '| left | right |\n| --- | --- |\n| a | b |\n\n' +
      '- [x] done\n- [ ] pending\n\n' +
      'A note[^n], [late][ref], ![alt](https://example.org/image "image title").\n\n' +
      '[^n]: A footnote\n\n[ref]: https://example.org/reference\n\n' +
      '[unsafe](javascript:alert%281%29) <b>raw HTML</b>'
    const actual = pipeline(input, true)
    expect(actual.html).toContain('<del>gone</del>')
    expect(actual.html).toContain('<table data-original-component="table">')
    expect(actual.html).toContain('type="checkbox"')
    expect(actual.html).toContain('data-footnotes')
    expect(actual.html).toContain('&lt;b&gt;raw HTML&lt;/b&gt;')
    expect(actual.urls).toContainEqual({ url: 'javascript:alert%281%29', key: 'href', safe: '' })
    expect(parity(input)).toEqual({ kind: 'full', reason: 'unsupported' })
  })

  it.each(['\n', '\r', '\r\n'])(
    'takes indented mutable blocks at their source line start with %j',
    (nl) => {
      const input = `Heading${nl}${nl}First café 😀 with ![é](https://example.org "t").${nl}${nl}  Mutable text`
      const result = parity(input)
      expect(result.kind).toBe('candidate')
      if (result.kind !== 'candidate') throw new Error('Position proof did not qualify')
      expect(result.snapshot.cut).toBe(input.indexOf('  Mutable'))
      expect(result.snapshot.line).toBe(5)
      expect(result.snapshot.accounting.sourceSpanCodeUnits).toBe(result.snapshot.cut)
      expect(result.accounting.sourceBytes).toBe(
        2 * (result.snapshot.cut + result.accounting.astStringCodeUnits)
      )
    }
  )

  it('falls back without retained input/nodes for final, unsupported, or reset-BOM input', () => {
    for (const input of [
      'one',
      '',
      'first\n\n> quote',
      'first\n\n[ref]: /target',
      'first\n\n\uFEFFtail'
    ]) {
      const result = parity(input)
      expect(result.kind).toBe('full')
      expect(result).not.toHaveProperty('snapshot')
    }
    expect(parity('first\n\nsecond', true)).toEqual({ kind: 'full', reason: 'final' })
  })

  it('charges duplicate source-derived string occurrences and both UTF-16 surrogate units', () => {
    const input = '[😀](https://a "same") [😀](https://a "same")\n\ntail'
    const result = parity(input)
    if (result.kind !== 'candidate') throw new Error('Accounting fixture did not qualify')
    // Two link labels, two URLs, two titles and the separating space.
    expect(result.accounting.astStringCodeUnits).toBe(2 * (2 + 9 + 4) + 1)
    expect(result.accounting.sourceBytes).toBe(2 * (input.indexOf('tail') + 31))
  })
})

describe('hard caps on the complete parser-confirmed candidate', () => {
  it('accepts the exact UTF-16 source budget and releases metadata above it', () => {
    for (const [count, bytes, fits] of [
      [32767, 131072, true],
      [32768, 131076, false]
    ] as const) {
      const result = parity('a'.repeat(count) + '\n\ntail')
      expect(result.accounting?.sourceBytes).toBe(bytes)
      expect(result.kind).toBe(fits ? 'candidate' : 'full')
      if (!fits)
        expect(result).toEqual({
          kind: 'full',
          reason: 'source-cap',
          accounting: result.accounting
        })
    }
  })

  it('does not silently retain only 64 blocks from a 65-block prefix', () => {
    for (const count of [64, 65]) {
      const input =
        Array.from({ length: count }, (_, n) => `Paragraph ${n}.\n\n`).join('') + 'mutable'
      const result = parity(input)
      expect(result.accounting?.blocks).toBe(count)
      expect(result.kind).toBe(count === 64 ? 'candidate' : 'full')
      if (count === 65)
        expect(result).toEqual({ kind: 'full', reason: 'block-cap', accounting: result.accounting })
    }
  })

  it('counts actual descendant nodes at and above the 4096-node cap', () => {
    for (const [count, nodes, fits] of [
      [1365, 4096, true],
      [1366, 4099, false]
    ] as const) {
      const result = parity('**a** '.repeat(count) + 'x\n\nmutable')
      expect(result.accounting?.nodes).toBe(nodes)
      expect(result.kind).toBe(fits ? 'candidate' : 'full')
      if (!fits)
        expect(result).toEqual({ kind: 'full', reason: 'node-cap', accounting: result.accounting })
    }
  })
})

describe('actual parser-produced prefix accounting', () => {
  it('measures independent ordinary prose through representative appends', () => {
    const start =
      '# Field notes\n\nWe reviewed **accessibility** and [navigation](https://example.org/guide "Guide").\n\nA reader can keep their place.\n\n'
    for (const tail of [
      '',
      'The next observation',
      'The next observation grows with café 😀.',
      '\nAnother paragraph starts.'
    ]) {
      const result = parity(start + tail)
      expect(result.kind).toBe('candidate')
      if (result.kind !== 'candidate') throw new Error('Ordinary accounting failed')
      expect(accountPrefix(result.snapshot.blocks, result.snapshot.cut)).toEqual(result.accounting)
      expect(result.accounting.sourceBytes).toBeLessThanOrEqual(PREFIX_LIMITS.sourceBytes)
      expect(result.accounting.nodes).toBeLessThanOrEqual(PREFIX_LIMITS.nodes)
      console.log(
        JSON.stringify({
          scenario: 'ordinary-prefix',
          inputCodeUnits: (start + tail).length,
          tailCodeUnits: tail.length,
          ...result.accounting
        })
      )
    }
  })

  it('measures the actual unchanged workload initially and at representative appends without tuning a prefix', () => {
    expect(typeof LONG_RESPONSE).toBe('string')
    expect(typeof streamChunk(0)).toBe('string')
    for (const appendCount of [0, 1, 20, 100, 500]) {
      const input =
        LONG_RESPONSE + Array.from({ length: appendCount }, (_, n) => streamChunk(n)).join('')
      const result = parity(input)
      const accounting = result.accounting
      expect(accounting).toBeDefined()
      if (!accounting) throw new Error('Actual workload candidate was not accounted')
      expect(accounting.blocks).toBe(appendCount === 0 ? 23 : 24)
      const fits =
        accounting.blocks <= PREFIX_LIMITS.blocks &&
        accounting.sourceBytes <= PREFIX_LIMITS.sourceBytes &&
        accounting.nodes <= PREFIX_LIMITS.nodes
      expect(result.kind).toBe(fits ? 'candidate' : 'full')
      if (result.kind === 'candidate') {
        expect(result.snapshot.input).toBe(input)
        expect(accountPrefix(result.snapshot.blocks, result.snapshot.cut)).toEqual(accounting)
      } else {
        expect(result).not.toHaveProperty('snapshot')
      }
      console.log(
        JSON.stringify({
          scenario: 'workload-prefix',
          appendCount,
          inputCodeUnits: input.length,
          kind: result.kind,
          ...accounting
        })
      )
    }
  })
})
