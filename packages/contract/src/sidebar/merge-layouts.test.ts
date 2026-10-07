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

  it('the window’s change wins on a group both touched, and the server keeps its own additions', () => {
    const base = L([g('a', ['s1'])], ['a'])
    const local = L([g('a', ['s1', 's2'])], ['a'])
    const server = L([g('a', ['s1'], 'A by agent'), g('n')], ['a', 'n'])
    const out = mergeLayouts(base, local, server)
    expect(out.groups).toEqual([g('a', ['s1', 's2']), g('n')])
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
})
