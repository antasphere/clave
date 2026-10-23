import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import type { Root } from 'mdast'
import ReactMarkdown, { defaultUrlTransform, type Options } from 'react-markdown'
import { describe, expect, it } from 'vitest'
import { createEntryMarkdownPlugins } from '../../../../plugins/chat-view/src/markdown-append'
import { LONG_RESPONSE, streamChunk } from '../../../../tests/e2e/renderer-workload.mjs'
import { DEPTHS, literal } from '../../../../tests/e2e/markdown-deep-contract.mjs'
import { publicStages, sameData, checkDeepStages } from './markdown-full-pipeline-support'

type Plugins = NonNullable<Options['remarkPlugins']>
type Attacher = Extract<Plugins[number], (...parameters: never[]) => unknown>
type Processor = ThisParameterType<Attacher>
type Tree = ReturnType<NonNullable<Processor['parser']>>

function harness(streaming = true): {
  parse: (input: string) => ReturnType<typeof publicStages>
  calls: Array<{ document: string; fullFile: string }>
} {
  const plugins = createEntryMarkdownPlugins(streaming)
  const calls: Array<{ document: string; fullFile: string }> = []
  function instrument(this: Processor): void {
    const original = this.parser!
    this.parser = (document, file) => {
      calls.push({ document, fullFile: String(file.value) })
      return original(document, file)
    }
  }
  return {
    calls,
    parse(input) {
      let mdast: Tree | undefined, hast: unknown
      const urls: string[] = []
      const jsx = ReactMarkdown({
        children: input,
        // Instrument below the optimization, so only actual original-parser
        // inputs count. Every processor is fresh, as in public ReactMarkdown.
        remarkPlugins: [
          plugins[0],
          instrument,
          ...plugins.slice(1),
          () => (tree) => {
            mdast = tree
          }
        ],
        rehypePlugins: [
          () => (tree) => {
            hast = tree
          }
        ],
        urlTransform(url) {
          const safe = defaultUrlTransform(url)
          urls.push(url + ' => ' + safe)
          return safe
        }
      })
      expect(mdast).toBeDefined()
      return { mdast: mdast!, hast, jsx, urls, entries: [] }
    }
  }
}

function equal(input: string, actual: ReturnType<typeof publicStages>): void {
  const full = publicStages(input)
  for (const key of ['mdast', 'hast', 'jsx', 'urls'] as const)
    sameData(actual[key], full[key], 'complete actual ' + key)
}

describe('per-entry actual Markdown parser append reuse', () => {
  // This checks complete pipeline parity and parser-input work, not latency.
  // Allow a bounded 15-second completion budget for the full-suite CI run.
  it('reduces actual parser input on the original long response without dropping any output', () => {
    const h = harness()
    let input = LONG_RESPONSE
    equal(input, h.parse(input))
    for (let n = 0; n < 8; n++) {
      input += streamChunk(n)
      equal(input, h.parse(input))
    }
    expect(h.calls).toHaveLength(9)
    expect(
      h.calls.every(
        (call, n) =>
          call.fullFile ===
          LONG_RESPONSE + Array.from({ length: n }, (_, i) => streamChunk(i)).join('')
      )
    ).toBe(true)
    const fullWork = h.calls.reduce((sum, call) => sum + call.fullFile.length, 0)
    const actualWork = h.calls.reduce((sum, call) => sum + call.document.length, 0)
    console.log(
      JSON.stringify({
        proof: 'actual-configured-parser-input-not-latency',
        fullWork,
        actualWork,
        parserInputLengths: h.calls.map((call) => call.document.length)
      })
    )
    expect(actualWork).toBeLessThan(fullWork)
    expect(h.calls.slice(2).map((call) => call.document)).toEqual(
      Array.from({ length: 7 }, (_, n) =>
        Array.from({ length: n + 2 }, (_, i) => streamChunk(i)).join('')
      )
    )
  }, 15_000)

  it.each(DEPTHS as readonly number[])(
    'retains every original literal/position/stage at depth %s',
    (depth) => {
      const h = harness()
      for (const stage of ['initial', 'append'] as const) {
        const input = literal(depth, stage).input
        const result = h.parse(input)
        checkDeepStages(result, depth, stage)
        equal(input, result)
      }
      // Also take the fast path after the original independent literal cases.
      const input = literal(depth, 'append').input + ' grows'
      equal(input, h.parse(input))
    }
  )

  const prefixes = [
    '# Heading\n\n',
    '[defined][x] and [missing]\n\n[x]: https://example.org/ref "title"\n\n',
    '- [x] task\n- [ ] pending\n\n',
    '| a | b |\n|---|---|\n| one | two |\n\n',
    '> **quoted**\n> second line\n\n',
    '```js\nconst a = 1\n```\n\n',
    '<div>raw HTML</div>\n\n',
    'Unicode 雪 😀\r\n\r\n',
    'CR only\r\r',
    '[^a] footnote\n\n[^a]: note\n\n',
    '~~strike~~ www.example.org a@example.org <https://example.org>\n\n',
    '[unsafe](javascript:bad) &amp; \\*literal\\*\n\n'
  ]
  it.each(prefixes)(
    'retains rich prefix, full positions and independent serialization: %s',
    (prefix) => {
      const h = harness()
      let input = prefix + 'Plain'
      for (const append of ['', ' ascii', ' 12', ' ', ' more']) {
        input += append
        const result = h.parse(input)
        equal(input, result)
        expect(renderToStaticMarkup(result.jsx as ReactNode)).toBe(
          renderToStaticMarkup(publicStages(input).jsx as ReactNode)
        )
      }
      expect(h.calls.at(-1)!.document.length).toBeLessThan(input.length)
    }
  )

  it.each([
    '\n',
    '\r',
    '\t',
    '*',
    '_',
    '~',
    '[',
    ']',
    '`',
    '\\',
    '&amp;',
    '<a>',
    '.com',
    '@mail.org',
    ':',
    'é',
    '\u0000'
  ])('uses the full original parser for ambiguous append %j', (append) => {
    const h = harness()
    let input = '# Earlier\n\nPlain'
    equal(input, h.parse(input))
    input += append
    equal(input, h.parse(input))
    expect(h.calls.at(-1)!.document).toBe(input)
  })

  it.each([
    '```\nopen',
    '> quote',
    '- list',
    '[x',
    'https://example.org',
    'a@example.org',
    'www.example',
    '    code',
    '<div>open',
    'plain\nsecond',
    'plain &amp;',
    'plain\\',
    '[x]: https://example.org'
  ])('does not reuse an ambiguous or non-root plain tail %j', (tail) => {
    const h = harness()
    const input = '# Earlier\n\n' + tail
    equal(input, h.parse(input))
    equal(input + ' grows', h.parse(input + ' grows'))
    expect(h.calls.at(-1)!.document).toBe(input + ' grows')
  })

  it('handles correction, shrink, replacement and late definitions through the full parser', () => {
    const h = harness()
    for (const input of [
      '[late][x]\n\nPlain',
      '[late][x]\n\nPlain grows',
      '[late][x]\n\nPlain grows\n\n[x]: https://example.org/now',
      'Replaced',
      '',
      '# Changed\n\nOther',
      '# Changed\n\nOther grows'
    ])
      equal(input, h.parse(input))
  })

  it('uses the full parser for leading BOM inputs whose offsets exclude the BOM', () => {
    const h = harness()
    let input = '\uFEFF# BOM\n\nPlain'
    for (const append of ['', ' ascii', ' 12', ' ', ' more']) {
      input += append
      equal(input, h.parse(input))
      expect(h.calls.at(-1)!.document).toBe(input)
    }
  })

  it('does not let returned-tree mutation contaminate the retained parse', () => {
    const h = harness()
    const input = '# Earlier\n\nPlain'
    const first = h.parse(input)
    ;(first.mdast as Root).children.length = 0
    equal(input + ' grows', h.parse(input + ' grows'))
  })

  it('owns no cross-entry or completed-message reuse', () => {
    const first = harness(),
      second = harness(),
      finished = harness(false)
    const input = '# Earlier\n\nPlain'
    first.parse(input)
    first.parse(input + ' grows')
    equal(input + ' grows', second.parse(input + ' grows'))
    expect(second.calls[0].document).toBe(input + ' grows')
    for (const text of [input, input + ' grows']) equal(text, finished.parse(text))
    expect(finished.calls.map((c) => c.document)).toEqual([input, input + ' grows'])
  })

  it('retains only the current parse rather than looking up an older entry/source', () => {
    const h = harness()
    const first = '# First\n\nPlain'
    const second = '# Second\n\nOther'
    for (const input of [first, first + ' grows', second, first + ' grows again'])
      equal(input, h.parse(input))
    expect(h.calls.at(-1)!.document).toBe(first + ' grows again')
  })

  it('propagates the captured parser error by identity and discards the old cache on error', () => {
    const plugins = createEntryMarkdownPlugins(true)
    const failure = new Error('actual configured parser error')
    let fail = false
    const calls: string[] = []
    function throwing(this: Processor): void {
      const original = this.parser!
      this.parser = (document, file) => {
        calls.push(document)
        const tree = original(document, file)
        if (fail) throw failure
        return tree
      }
    }
    const parse = (input: string): ReactNode =>
      ReactMarkdown({
        children: input,
        remarkPlugins: [plugins[0], throwing, ...plugins.slice(1)]
      })
    const input = '# Earlier\n\nPlain'
    parse(input)
    fail = true
    let caught: unknown
    try {
      parse(input + ' grows')
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
    fail = false
    parse(input + ' grows again')
    expect(calls.at(-1)).toBe(input + ' grows again')
  })

  it('compares a bounded deterministic mixed-grammar append/correction corpus', () => {
    let seed = 0x7a113
    const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
    const suffixes = [
      ' a',
      ' 12',
      ' Z9',
      ' ',
      '\n\nNew',
      ' *strong*',
      ' [x][ref]',
      '\n[ref]: /late',
      '.org',
      '\\',
      ' &copy;',
      '\r\nnext'
    ]
    for (let n = 0; n < 40; n++) {
      const h = harness()
      let input = prefixes[random() % prefixes.length] + 'Plain'
      for (let step = 0; step < 6; step++) {
        input += suffixes[random() % suffixes.length]
        if (step === 4 && n % 3 === 0) input = input.slice(0, input.length - 4)
        equal(input, h.parse(input))
      }
    }
  })
})
