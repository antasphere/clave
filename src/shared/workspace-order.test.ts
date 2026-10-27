import { describe, expect, it } from 'vitest'
import { moveInList, orderByIds } from './workspace-order'

const list = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
const ids = (l: readonly { id: string }[]): string[] => l.map((w) => w.id)

describe('moveInList (#257)', () => {
  it('moves an entry before or after another', () => {
    expect(ids(moveInList(list, 'd', 'a', 'before'))).toEqual(['d', 'a', 'b', 'c'])
    expect(ids(moveInList(list, 'a', 'd', 'after'))).toEqual(['b', 'c', 'd', 'a'])
    expect(ids(moveInList(list, 'a', 'c', 'before'))).toEqual(['b', 'a', 'c', 'd'])
    expect(ids(moveInList(list, 'd', 'b', 'after'))).toEqual(['a', 'b', 'd', 'c'])
  })

  it('answers the same array for a move that changes nothing', () => {
    expect(moveInList(list, 'b', 'b', 'before')).toBe(list)
    expect(moveInList(list, 'b', 'c', 'before')).toBe(list)
    expect(moveInList(list, 'c', 'b', 'after')).toBe(list)
    expect(moveInList(list, 'x', 'a', 'before')).toBe(list)
    expect(moveInList(list, 'a', 'x', 'before')).toBe(list)
  })
})

describe('orderByIds (#257)', () => {
  it('puts the list in the order named', () => {
    expect(ids(orderByIds(list, ['c', 'a', 'd', 'b']))).toEqual(['c', 'a', 'd', 'b'])
  })

  it('keeps an entry added since the order was read, and ignores one gone', () => {
    const now = [...list, { id: 'new' }].filter((w) => w.id !== 'b')
    expect(ids(orderByIds(now, ['d', 'c', 'b', 'a']))).toEqual(['d', 'c', 'a', 'new'])
  })

  it('reads a repeated id once', () => {
    expect(ids(orderByIds(list, ['b', 'b', 'a']))).toEqual(['b', 'a', 'c', 'd'])
  })
})
