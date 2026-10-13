import { describe, expect, it } from 'vitest'
import { mergeLayouts } from './ops-merge'

interface G {
  id: string
  name: string
  sessionIds: string[]
  terminals: { sessionId: string | null }[]
}
const g = (id: string, sessionIds: string[] = [], name = id): G => ({
  id,
  name,
  sessionIds,
  terminals: []
})
const L = (groups: G[], displayOrder: string[]): { groups: G[]; displayOrder: string[] } => ({
  groups,
  displayOrder
})

/**
 * The window's pending change over the server's fresh snapshot: what the
 * window added or changed survives a refused save, what the server changed
 * meanwhile is kept, and only an edit on a group the server removed is
 * dropped, reported by name so the window can say so.
 */
describe('mergeLayouts', () => {
  it('keeps the group the window added when an outside write landed first', () => {
    const base = L([], ['s1'])
    const local = L([g('mine', ['s1'])], ['mine'])
    const server = L([g('outside')], ['outside', 's1'])
    const out = mergeLayouts(base, local, server)
    expect(out.groups.map((x) => x.id)).toEqual(['outside', 'mine'])
    expect(out.displayOrder).toEqual(['mine', 'outside'])
    expect(out.dropped).toEqual([])
  })

  it('takes the server’s version of a group the window left alone, and its removal', () => {
    const base = L([g('a'), g('b')], ['a', 'b'])
    const local = L([g('a'), g('b')], ['a', 'b'])
    const server = L([g('a', [], 'A renamed')], ['a'])
    const out = mergeLayouts(base, local, server)
    expect(out.groups).toEqual([g('a', [], 'A renamed')])
    expect(out.displayOrder).toEqual(['a'])
    expect(out.dropped).toEqual([])
  })

  it('a group both touched merges field by field, and the server keeps its own additions', () => {
    const base = L([g('a', ['s1'])], ['a'])
    const local = L([g('a', ['s1', 's2'])], ['a'])
    const server = L([g('a', ['s1'], 'A by agent'), g('n')], ['a', 'n'])
    const out = mergeLayouts(base, local, server)
    expect(out.groups).toEqual([g('a', ['s1', 's2'], 'A by agent'), g('n')])
    expect(out.displayOrder).toEqual(['a', 'n'])
  })

  it('drops the window’s edit of a group the server removed, and names it', () => {
    const base = L([g('a', ['s1'])], ['a'])
    const local = L([g('a', ['s1', 's2'], 'Lanes')], ['a'])
    const server = L([], ['s1'])
    const out = mergeLayouts(base, local, server)
    expect(out.groups).toEqual([])
    expect(out.dropped).toEqual([{ id: 'a', name: 'Lanes' }])
    expect(out.displayOrder).toEqual(['s1'])
  })

  it('applies the window’s removal of a group the server still has', () => {
    const base = L([g('a'), g('b')], ['a', 'b'])
    const local = L([g('b')], ['b'])
    const server = L([g('a'), g('b')], ['a', 'b'])
    const out = mergeLayouts(base, local, server)
    expect(out.groups.map((x) => x.id)).toEqual(['b'])
    expect(out.displayOrder).toEqual(['b'])
  })

  it('keeps the window’s order of what still exists and never surfaces a nested id', () => {
    const base = L([g('a', ['s1'])], ['a', 's2'])
    const local = L([g('a', ['s1'])], ['s2', 'a'])
    const server = L([g('a', ['s1', 's2'])], ['a'])
    const out = mergeLayouts(base, local, server)
    expect(out.groups).toEqual([g('a', ['s1', 's2'])])
    expect(out.displayOrder).toEqual(['a'])
  })

  it('an idle window in sync with the server yields the server’s layout unchanged', () => {
    const layout = L([g('a', ['s1']), g('b')], ['a', 'b', 's2'])
    const out = mergeLayouts(layout, layout, L([g('a', ['s1'])], ['a', 's2']))
    expect(out.groups).toEqual([g('a', ['s1'])])
    expect(out.displayOrder).toEqual(['a', 's2'])
    expect(out.dropped).toEqual([])
  })

  it('an idle window takes a reorder, a placement and a new group made elsewhere as they are', () => {
    const synced = L([g('a', ['s1'])], ['a', 'b', 's2'])
    // A reorder elsewhere.
    expect(
      mergeLayouts(synced, synced, L([g('a', ['s1'])], ['b', 's2', 'a'])).displayOrder
    ).toEqual(['b', 's2', 'a'])
    // A session placed first elsewhere.
    expect(
      mergeLayouts(synced, synced, L([g('a', ['s1'])], ['s9', 'a', 'b', 's2'])).displayOrder
    ).toEqual(['s9', 'a', 'b', 's2'])
    // A group created elsewhere at a member's place.
    const made = L([g('a', ['s1']), g('n', ['s2'])], ['a', 'b', 'n'])
    const out = mergeLayouts(synced, synced, made)
    expect(out.groups.map((x) => x.id)).toEqual(['a', 'n'])
    expect(out.displayOrder).toEqual(['a', 'b', 'n'])
    expect(out.dropped).toEqual([])
  })

  it('a group both touched keeps the rename made elsewhere and the member added here', () => {
    const base = L([g('a', ['s1'])], ['a'])
    const local = L([g('a', ['s1', 's2'])], ['a'])
    const server = L([g('a', ['s1'], 'Renamed by B')], ['a'])
    const out = mergeLayouts(base, local, server)
    expect(out.groups).toEqual([g('a', ['s1', 's2'], 'Renamed by B')])
    expect(out.dropped).toEqual([])
  })

  it('a member leaving a group the server removed is no edit: nothing dropped, nothing reported', () => {
    const base = L([g('a', ['s1', 's2'])], ['a'])
    const local = L([g('a', ['s1'])], ['a', 's2'])
    const server = L([], ['s1', 's2'])
    const out = mergeLayouts(base, local, server)
    expect(out.groups).toEqual([])
    expect(out.dropped).toEqual([])
    expect(out.displayOrder).toEqual(['s1', 's2'])
  })

  it('the window’s reorder wins over the server’s order when the window reordered', () => {
    const base = L([], ['a', 'b', 'c'])
    const local = L([], ['c', 'a', 'b'])
    const server = L([], ['a', 'b', 'c', 'd'])
    expect(mergeLayouts(base, local, server).displayOrder).toEqual(['c', 'a', 'b', 'd'])
  })

  it('a row the window removed stays out, even though the server still lists it', () => {
    const base = L([g('a')], ['a', 's1', 's2'])
    const local = L([g('a')], ['a', 's1'])
    const server = L([g('a')], ['a', 's1', 's2'])
    expect(mergeLayouts(base, local, server).displayOrder).toEqual(['a', 's1'])
  })

  it('a row the window added enters after its local predecessor, not at the end', () => {
    const base = L([], ['a', 'b'])
    const local = L([], ['a', 'x', 'b'])
    const server = L([], ['a', 'b'])
    expect(mergeLayouts(base, local, server).displayOrder).toEqual(['a', 'x', 'b'])
  })

  it('a field the window cleared on a both-touched group stays cleared', () => {
    const was = { ...g('a'), color: 'teal' } as G & { color?: string }
    const mine = { ...g('a') } as G & { color?: string }
    const theirs = { ...g('a', [], 'A by agent'), color: 'teal' } as G & { color?: string }
    const out = mergeLayouts(L([was], ['a']), L([mine], ['a']), L([theirs], ['a']))
    expect(out.groups[0]).toEqual(g('a', [], 'A by agent'))
    expect('color' in out.groups[0]).toBe(false)
  })

  it('with no base known, nothing reads as a removal: both sides’ groups are kept', () => {
    const empty = L([], [])
    const local = L([g('mine', ['s1'])], ['mine'])
    const server = L([g('theirs', ['s2'])], ['theirs', 's3'])
    const out = mergeLayouts(empty, local, server)
    expect(out.groups.map((x) => x.id)).toEqual(['theirs', 'mine'])
    expect(out.displayOrder).toEqual(['mine', 'theirs', 's3'])
    expect(out.dropped).toEqual([])
  })
})
