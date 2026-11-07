import { cloneElement, createElement, isValidElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import { describe, expect, it } from 'vitest'
import { DEPTHS, literal } from '../../../../tests/e2e/markdown-deep-contract.mjs'
import { LONG_RESPONSE } from '../../../../tests/e2e/renderer-workload.mjs'
import { checkDeepStages, project, publicStages, sameData } from './markdown-full-pipeline-support'

describe('shipping full public ReactMarkdown/GFM pipeline', () => {
  it.each(DEPTHS as readonly number[])(
    'retains the complete independent grammar at depth %s',
    (depth) => {
      for (const stage of ['initial', 'append'] as const) {
        const result = publicStages(literal(depth, stage).input)
        checkDeepStages(result, depth, stage)
        expect(result.entries).toEqual([
          {
            length: literal(depth, stage).input.length,
            fullLength: literal(depth, stage).input.length,
            sameFile: true
          }
        ])
        const repeated = publicStages(literal(depth, stage).input)
        for (const key of ['mdast', 'hast', 'jsx', 'urls'] as const)
          sameData(result[key], repeated[key], key)
      }
    }
  )

  it('keeps complete positions, GFM structures and render URL/key/props/order', () => {
    const inputs = [
      LONG_RESPONSE,
      '# Heading\n\n- [x] checked\n- [ ] pending\n\n| a | b |\n|---|---|\n| one | two |\n\n~~gone~~ `code`\n\n[safe](https://example.org/path "title") [unsafe](javascript:bad)\n\n[x]: https://example.org/ref\n\n[reference][x]'
    ]
    for (const input of inputs) {
      const result = publicStages(input)
      expect(result.mdast.position).toMatchObject({
        start: { offset: 0 },
        end: { offset: input.length }
      })
      const before = JSON.stringify(project(result))
      const repeated = publicStages(input)
      for (const key of ['mdast', 'hast', 'jsx', 'urls'] as const)
        sameData(result[key], repeated[key], key)
      expect(JSON.stringify(project(result))).toBe(before)
    }
    const result = publicStages(inputs[1])
    expect(result.urls).toEqual([
      'https://example.org/path => https://example.org/path',
      'javascript:bad => ',
      'https://example.org/ref => https://example.org/ref'
    ])
    const jsx = JSON.stringify(project(result.jsx))
    for (const value of [
      'Heading',
      'checked',
      'pending',
      'table',
      'thead',
      'tbody',
      'del',
      'code',
      'title',
      'reference',
      'https://example.org/ref'
    ])
      expect(jsx).toContain(value)
    expect(jsx).not.toContain('javascript:bad')
    expect(JSON.stringify(project(result.mdast))).toContain('checked')
  })

  it('propagates actual configured parser and downstream errors with the full VFile', () => {
    const input = 'Earlier\n\nMutable grows'
    let originalFile: unknown
    expect(() =>
      ReactMarkdown({
        children: input,
        remarkPlugins: [
          function () {
            const parser = this.parser!
            this.parser = (document, file) => {
              expect(document).toBe(input)
              expect(String(file.value)).toBe(input)
              originalFile = file
              parser(document, file)
              throw new Error('actual parser failure')
            }
          }
        ]
      })
    ).toThrow('actual parser failure')
    expect(originalFile).toBeDefined()
    expect(() =>
      ReactMarkdown({
        children: input,
        remarkPlugins: [
          () => (_tree, file) => {
            expect(String(file.value)).toBe(input)
            throw new Error('actual downstream failure')
          }
        ]
      })
    ).toThrow('actual downstream failure')
  })

  it('rejects incomplete literals, changed positions, HAST/JSX order and lost render props', () => {
    const complete = (): ReturnType<typeof publicStages> =>
      publicStages(literal(16, 'initial').input)
    const missing = complete()
    ;(missing.mdast as unknown as { children: unknown[] }).children.pop()
    expect(() => checkDeepStages(missing, 16, 'initial')).toThrow('positional MDAST')
    const position = complete()
    position.mdast.position!.end.offset!--
    expect(() => checkDeepStages(position, 16, 'initial')).toThrow('positional MDAST')
    const wrongJsx = complete()
    wrongJsx.jsx = createElement('p', null, 'middle')
    expect(() => checkDeepStages(wrongJsx, 16, 'initial')).toThrow('JSX literal')
    const wrongHast = complete()
    ;(wrongHast.hast as { children: unknown[] }).children.reverse()
    expect(() => checkDeepStages(wrongHast, 16, 'initial')).toThrow('HAST')
    const a = createElement('a', { key: 'a', href: '/a', style: { color: 'red' } }, 'one', 'two')
    for (const b of [
      createElement('a', { key: 'b', href: '/a', style: { color: 'red' } }, 'one', 'two'),
      createElement('a', { key: 'a', href: '/a', style: { color: 'blue' } }, 'one', 'two'),
      createElement('a', { key: 'a', href: '/a', style: { color: 'red' } }, 'two', 'one')
    ])
      expect(() => sameData(a, b, 'render props')).toThrow()
    expect(() => project(createElement('button', { onClick: () => {} }))).toThrow()
    expect(() => sameData({ n: NaN }, { n: Infinity }, 'exact')).toThrow()
    expect(() => sameData({ n: -0 }, { n: 0 }, 'exact')).toThrow()
  })

  it('rejects independently wrong HAST positions or JSX keys even with identical HTML', () => {
    const position = publicStages(literal(16, 'initial').input)
    ;(position.hast as { position: { end: { offset: number } } }).position.end.offset--
    expect(() => checkDeepStages(position, 16, 'initial')).toThrow('positioned HAST')
    const key = publicStages(literal(16, 'initial').input)
    if (!isValidElement<{ children: ReactNode[] }>(key.jsx)) throw new Error('root element missing')
    const children = [...key.jsx.props.children]
    if (!isValidElement(children[0])) throw new Error('paragraph element missing')
    children[0] = cloneElement(children[0], { key: 'changed-key' })
    key.jsx = cloneElement(key.jsx, {}, children)
    expect(() => checkDeepStages(key, 16, 'initial')).toThrow('JSX keys/props/order')
  })
})
