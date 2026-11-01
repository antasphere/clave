import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import {
  checkDeepStages,
  compareDeep,
  project,
  publicStages,
  sameData
} from './markdown-parser-deep-test-support'
import { DEPTHS, literal } from '../../../../tests/e2e/markdown-deep-contract.mjs'

describe('complete public synchronous Markdown pipeline', () => {
  it.each(DEPTHS as readonly number[])(
    'preserves every stage, position and shorter append at depth %s',
    (depth) => {
      const slot = { current: undefined } as Parameters<typeof compareDeep>[1]
      compareDeep(literal(depth, 'initial').input, slot, depth, 'initial')
      compareDeep(literal(depth, 'append').input, slot, depth, 'append')
    }
  )

  it('retains fixed safe/unsafe URL transforms and render props on both arms', () => {
    const slot: Parameters<typeof compareDeep>[1] = { current: undefined }
    const first = 'Earlier\n\n[safe](https://example.org/path "title") [unsafe](javascript:bad)'
    for (const input of [first, first + ' grows']) {
      const full = publicStages(input),
        attempt = publicStages(input, slot)
      expect(full.urls).toEqual([
        'https://example.org/path => https://example.org/path',
        'javascript:bad => '
      ])
      for (const key of ['mdast', 'hast', 'jsx', 'urls'] as const)
        sameData(full[key], attempt[key], key)
      const output = JSON.stringify(project(attempt.jsx))
      expect(output).toContain('https://example.org/path')
      expect(output).toContain('title')
      expect(output).not.toContain('javascript:bad')
    }
  })

  it('rejects equal-but-incomplete arms and changes to positions, order and literal tail', () => {
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
    expect(() => checkDeepStages(wrongHast, 16, 'initial')).toThrow('HAST literal')
  })

  it('preserves nonprimitive props, keys, child order and rejects unsupported values', () => {
    const a = createElement('a', { key: 'a', href: '/a', style: { color: 'red' } }, 'one', 'two')
    const variants = [
      createElement('a', { key: 'b', href: '/a', style: { color: 'red' } }, 'one', 'two'),
      createElement('a', { key: 'a', href: '/a', style: { color: 'blue' } }, 'one', 'two'),
      createElement('a', { key: 'a', href: '/a', style: { color: 'red' } }, 'two', 'one')
    ]
    for (const value of variants)
      expect(() => sameData(a, value, 'render prop/key/order')).toThrow()
    expect(() => project(createElement('button', { onClick: () => {} }))).toThrow(
      'unsupported projected value'
    )
    expect(() => project(new Date())).toThrow('prototype')
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(() => project(cycle)).toThrow('cyclic projection')
    expect(() => project({ [Symbol('unknown')]: 1 })).toThrow('symbol-keyed')
    expect(() => sameData({ value: NaN }, { value: Infinity }, 'exact number')).toThrow()
    expect(() => sameData({ value: -0 }, { value: 0 }, 'signed zero')).toThrow()
  })
})
