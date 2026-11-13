import { createElement, Fragment, isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import { demand } from '../../../../tests/e2e/markdown-deep-contract.mjs'
import { project as fullProject, sameData as fullSameData } from './markdown-full-pipeline-support'
import {
  project as legacyProject,
  sameData as legacySameData
} from './markdown-parser-deep-test-support'

// Exact C1 project() reference, renamed only. Use it solely on the small corpus
// below (depth <= 16), never on the original deep pipeline/append fixtures.
function referenceProject(value: unknown): unknown[] {
  const result: unknown[] = []
  const pending: Array<{ value: unknown; path: string; ancestors: object[] }> = [
    { value, path: '$', ancestors: [] }
  ]
  while (pending.length) {
    const item = pending.pop()!
    let current = item.value
    const ancestors = [...item.ancestors]
    if (current && typeof current === 'object') {
      demand(!ancestors.includes(current), 'cyclic projection')
      ancestors.push(current)
    }
    if (isValidElement<Record<string, unknown>>(current)) {
      demand(typeof current.type === 'string' || current.type === Fragment, 'unsupported JSX type')
      current = {
        element: current.type === Fragment ? 'Fragment' : current.type,
        key: current.key,
        props: current.props
      }
    }
    if (current === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof current)) {
      // JSON otherwise aliases NaN/Infinity and drops the sign of zero.
      const exact =
        typeof current === 'number' ? (Object.is(current, -0) ? '-0' : String(current)) : current
      result.push([item.path, typeof current, exact])
      continue
    }
    demand(typeof current === 'object' && current !== null, 'unsupported projected value')
    const object = current as Record<string, unknown>
    demand(
      Array.isArray(object) || [Object.prototype, null].includes(Object.getPrototypeOf(object)),
      'unsupported projected prototype'
    )
    demand(Object.getOwnPropertySymbols(object).length === 0, 'symbol-keyed projection')
    const keys = Object.keys(object).sort()
    result.push([
      item.path,
      Array.isArray(object) ? 'array' : 'object',
      keys,
      Array.isArray(object) ? object.length : null
    ])
    for (let i = keys.length - 1; i >= 0; i--)
      pending.push({ value: object[keys[i]], path: item.path + '/' + keys[i], ancestors })
  }
  return result
}

function nested(depth: number): unknown {
  let value: unknown = { text: 'middle', position: { offset: 3 } }
  for (let n = 0; n < depth; n++) value = { children: [value], index: n }
  return value
}

function corpus(): unknown[] {
  const sparse = new Array<unknown>(3)
  sparse[1] = 'one'
  const extra = ['one']
  Object.defineProperty(extra, 'note', { value: 'extra', enumerable: true })
  const hidden = { value: 1 }
  Object.defineProperty(hidden, 'hidden', { value: () => {}, enumerable: false })
  const shared = { value: 1 }
  const element = createElement(
    'a',
    { key: 'a', href: '/a', style: { color: 'red' } },
    'one',
    'two'
  )
  return [
    undefined,
    null,
    false,
    true,
    '',
    '0',
    0,
    -0,
    1,
    NaN,
    Infinity,
    -Infinity,
    {},
    Object.create(null),
    [],
    new Array(1),
    [undefined],
    [null],
    [0],
    ['0'],
    { value: undefined },
    { value: null },
    { value: 0 },
    { value: -0 },
    { value: NaN },
    { value: Infinity },
    { value: -Infinity },
    { a: 1, b: 2 },
    { b: 2, a: 1 },
    { a: 2, b: 1 },
    { a: 1 },
    { a: {} },
    { a: [] },
    { a: { b: 1 } },
    { 'a/b': 1 },
    { '': 'empty', '/': 'slash', '~': 'tilde', 雪: 'unicode' },
    JSON.parse('{"__proto__":1}'),
    sparse,
    [undefined, 'one', undefined],
    extra,
    ['one'],
    hidden,
    { a: shared, b: shared },
    { a: { value: 1 }, b: { value: 1 } },
    element,
    {
      element: 'a',
      key: 'a',
      props: { href: '/a', style: { color: 'red' }, children: ['one', 'two'] }
    },
    createElement('a', { key: 'b', href: '/a', style: { color: 'red' } }, 'one', 'two'),
    createElement('a', { key: 'a', href: '/b', style: { color: 'red' } }, 'one', 'two'),
    createElement('a', { key: 'a', href: '/a', style: { color: 'blue' } }, 'one', 'two'),
    createElement('a', { key: 'a', href: '/a', style: { color: 'red' } }, 'two', 'one'),
    createElement(Fragment, null, createElement('p', null, 'one'), 'two'),
    ...[0, 1, 4, 16].map(nested)
  ]
}

function caught(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('Expected projection to fail')
}

describe.each([
  { name: 'full pipeline', project: fullProject, sameData: fullSameData },
  { name: 'legacy pipeline', project: legacyProject, sameData: legacySameData }
])('$name projection preserves its comparison domain', ({ project, sameData }) => {
  it('matches old equality acceptance across the bounded value/shape/React corpus', () => {
    const values = corpus()
    const old = values.map((value) => JSON.stringify(referenceProject(value)))
    const current = values.map((value) => JSON.stringify(project(value)))
    let accepted = 0,
      rejected = 0
    for (let left = 0; left < values.length; left++)
      for (let right = 0; right < values.length; right++) {
        const equal = old[left] === old[right]
        expect(current[left] === current[right]).toBe(equal)
        if (equal) accepted++
        else rejected++
      }
    expect(accepted).toBeGreaterThan(values.length)
    expect(rejected).toBeGreaterThan(accepted)
    console.log(
      JSON.stringify({
        proof: 'projection-acceptance',
        values: values.length,
        accepted,
        rejected,
        referenceMaxDepth: 16
      })
    )
  })

  it('discriminates every data field, shape, array slot and special primitive', () => {
    const pairs: Array<[unknown, unknown]> = [
      [undefined, null],
      [false, 0],
      [0, -0],
      [NaN, Infinity],
      [Infinity, -Infinity],
      [1, '1'],
      [{ value: undefined }, {}],
      [{ value: 1 }, { changed: 1 }],
      [{ value: 1 }, { value: 2 }],
      [{ children: [1, 2] }, { children: [2, 1] }],
      [{ position: { start: { offset: 1 } } }, { position: { start: { offset: 2 } } }],
      [new Array(1), [undefined]],
      [[], new Array(1)],
      [[1], { 0: 1 }],
      [{ a: { b: 1 } }, { 'a/b': 1 }],
      [createElement('p', { key: 'a' }, 'one'), createElement('p', { key: 'b' }, 'one')],
      [createElement('a', { href: '/a' }, 'one'), createElement('a', { href: '/b' }, 'one')],
      [
        createElement('p', { style: { color: 'red' } }),
        createElement('p', { style: { color: 'blue' } })
      ]
    ]
    const extra = [1]
    Object.defineProperty(extra, 'note', { value: 2, enumerable: true })
    pairs.push([extra, [1]])
    for (const [left, right] of pairs) {
      expect(JSON.stringify(referenceProject(left))).not.toBe(
        JSON.stringify(referenceProject(right))
      )
      expect(() => sameData(left, right, 'semantic mutation')).toThrow('semantic mutation')
    }
  })

  it('keeps shared acyclic branches, null prototypes and normalization equality', () => {
    const shared = { value: [1, null, undefined] }
    expect(() =>
      sameData({ a: shared, b: shared }, { a: { ...shared }, b: { ...shared } }, 'alias')
    ).not.toThrow()
    expect(() =>
      sameData(Object.assign(Object.create(null), { x: 1 }), { x: 1 }, 'prototype')
    ).not.toThrow()
    const element = createElement('p', { key: 'p' }, 'text')
    const owner: { self?: unknown } = {}
    owner.self = owner
    expect(() =>
      sameData({ ...element, _owner: owner, _debugInfo: () => {} }, element, 'owner/debug')
    ).not.toThrow()
    expect(() => project({ _owner: () => {} })).toThrow('unsupported projected value')
  })

  it('fails closed with the exact old errors for unsupported values and cycles', () => {
    const self: { self?: unknown } = {}
    self.self = self
    const child: { parent?: unknown } = {}
    const parent = { child }
    child.parent = parent
    const values: unknown[] = [
      () => {},
      Symbol('value'),
      1n,
      { value: () => {} },
      { value: Symbol('prop') },
      new Date(0),
      new Map(),
      new Set(),
      /pattern/,
      Object.create({ inherited: true }),
      { [Symbol('key')]: 1 },
      self,
      parent,
      createElement(() => null),
      { ...createElement('p'), type: Symbol('component') },
      createElement('button', { onClick: () => {} })
    ]
    const hiddenSymbol = {}
    Object.defineProperty(hiddenSymbol, Symbol('hidden'), { value: 1 })
    values.push(hiddenSymbol)
    for (const value of values) {
      const before = caught(() => referenceProject(value))
      const after = caught(() => project(value))
      expect(before).toBeInstanceOf(Error)
      expect(after).toBeInstanceOf(Error)
      expect((after as Error).message).toBe((before as Error).message)
      expect(() => sameData(value, value, 'identical reference')).toThrow((before as Error).message)
    }
  })

  it('preserves eager reverse-key getter reads followed by lexicographic traversal', () => {
    const build = (log: string[]): object => {
      const child = (name: string): object =>
        Object.defineProperties(
          {},
          {
            a: {
              enumerable: true,
              get: () => {
                log.push(name + '.a')
                return 1
              }
            },
            z: {
              enumerable: true,
              get: () => {
                log.push(name + '.z')
                return 2
              }
            }
          }
        )
      return Object.defineProperties(
        {},
        {
          a: {
            enumerable: true,
            get: () => {
              log.push('a')
              return child('a')
            }
          },
          z: {
            enumerable: true,
            get: () => {
              log.push('z')
              return child('z')
            }
          }
        }
      )
    }
    const before: string[] = [],
      after: string[] = []
    referenceProject(build(before))
    project(build(after))
    expect(before).toEqual(['z', 'a', 'a.z', 'a.a', 'z.z', 'z.a'])
    expect(after).toEqual(before)
  })

  it('preserves thrown getter identity and left-then-right evaluation without shortcuts', () => {
    const sentinel = new Error('getter sentinel')
    for (const implementation of [referenceProject, project]) {
      const log: string[] = []
      const value = Object.defineProperties(
        {},
        {
          a: {
            enumerable: true,
            get: () => {
              log.push('a')
              return 1
            }
          },
          z: {
            enumerable: true,
            get: () => {
              log.push('z')
              throw sentinel
            }
          }
        }
      )
      expect(caught(() => implementation(value))).toBe(sentinel)
      expect(log).toEqual(['z'])
    }
    const log: string[] = []
    const side = (name: string, value: number): object =>
      Object.defineProperty({}, 'value', {
        enumerable: true,
        get: () => {
          log.push(name)
          return value
        }
      })
    expect(() => sameData(side('left', 1), side('right', 2), 'different')).toThrow('different')
    expect(log).toEqual(['left', 'right'])
    log.length = 0
    const same = side('same', 1)
    sameData(same, same, 'same reference')
    expect(log).toEqual(['same', 'same'])
    const throws = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        throw sentinel
      }
    })
    expect(caught(() => sameData(side('left', 1), throws, 'different'))).toBe(sentinel)
    log.length = 0
    expect(caught(() => sameData(throws, side('unread right', 1), 'different'))).toBe(sentinel)
    expect(log).toEqual([])
  })
})
