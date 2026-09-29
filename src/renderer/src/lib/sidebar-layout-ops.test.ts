import { describe, it, expect } from 'vitest'
import { moveLayoutItems, type OpsLayout, type OpsGroup } from './sidebar-layout-ops'

const g = (id: string, sessionIds: string[]): OpsGroup => ({ id, sessionIds })
const layout = (groups: OpsGroup[], displayOrder: string[]): OpsLayout<OpsGroup> => ({
  groups,
  displayOrder
})

describe('moveLayoutItems — rows', () => {
  it('moves exactly the given row into another group and leaves its siblings', () => {
    const next = moveLayoutItems(
      layout([g('A', ['a1', 'a2', 'a3']), g('B', ['b1'])], ['A', 'B']),
      ['a2'],
      'B',
      'inside'
    )
    expect(next).toEqual(layout([g('A', ['a1', 'a3']), g('B', ['b1', 'a2'])], ['A', 'B']))
  })

  it('reorders inside a group around a sibling row', () => {
    const base = layout([g('A', ['a1', 'a2', 'a3'])], ['A'])
    expect(moveLayoutItems(base, ['a3'], 'a1', 'before')!.groups[0].sessionIds).toEqual([
      'a3',
      'a1',
      'a2'
    ])
    expect(moveLayoutItems(base, ['a1'], 'a2', 'after')!.groups[0].sessionIds).toEqual([
      'a2',
      'a1',
      'a3'
    ])
  })

  it("joins the target row's group when dropped next to it", () => {
    const next = moveLayoutItems(layout([g('B', ['b1', 'b2'])], ['s0', 'B']), ['s0'], 'b1', 'after')
    expect(next).toEqual(layout([g('B', ['b1', 's0', 'b2'])], ['B']))
  })

  it('"inside" on a row reads as "after" that row', () => {
    const next = moveLayoutItems(
      layout([g('B', ['b1', 'b2'])], ['s0', 'B']),
      ['s0'],
      'b1',
      'inside'
    )
    expect(next!.groups[0].sessionIds).toEqual(['b1', 's0', 'b2'])
  })

  it('reorders at the top level around a group header or a standalone row', () => {
    const base = layout([g('A', ['a1'])], ['s0', 'A', 's1'])
    expect(moveLayoutItems(base, ['s1'], 'A', 'before')!.displayOrder).toEqual(['s0', 's1', 'A'])
    expect(moveLayoutItems(base, ['s0'], 's1', 'after')!.displayOrder).toEqual(['A', 's1', 's0'])
  })

  it('a null target is the explicit ungroup: the row goes to the end of the top level', () => {
    const next = moveLayoutItems(layout([g('A', ['a1', 'a2'])], ['A', 's0']), ['a1'], null, 'after')
    expect(next).toEqual(layout([g('A', ['a2'])], ['A', 's0', 'a1']))
  })

  it('an unknown target degrades to the same ungroup, never a drop', () => {
    const next = moveLayoutItems(layout([g('A', ['a1', 'a2'])], ['A']), ['a1'], 'gone', 'after')
    expect(next).toEqual(layout([g('A', ['a2'])], ['A', 'a1']))
  })

  it('drops the group the move emptied, but keeps a group that was already empty', () => {
    const next = moveLayoutItems(
      layout([g('A', ['a1']), g('E', []), g('B', ['b1'])], ['A', 'E', 'B']),
      ['a1'],
      'B',
      'inside'
    )
    expect(next).toEqual(layout([g('E', []), g('B', ['b1', 'a1'])], ['E', 'B']))
  })

  it('returns null for a no-op drop (the row is already there), so undo records nothing', () => {
    const base = layout([g('A', ['a1', 'a2'])], ['A', 's0'])
    expect(moveLayoutItems(base, ['a2'], 'a1', 'after')).toBeNull()
    expect(moveLayoutItems(base, ['s0'], 'A', 'after')).toBeNull()
    expect(moveLayoutItems(base, [], 'A', 'inside')).toBeNull()
    expect(moveLayoutItems(base, ['A'], 'A', 'inside')).toBeNull()
  })
})

describe('moveLayoutItems — groups', () => {
  it('reorders a group at the top level', () => {
    const base = layout([g('A', ['a1']), g('B', ['b1'])], ['A', 's0', 'B'])
    expect(moveLayoutItems(base, ['B'], 'A', 'before')!.displayOrder).toEqual(['B', 'A', 's0'])
  })

  it('never nests a group: "inside" another group lands beside it', () => {
    const base = layout([g('A', ['a1']), g('B', ['b1'])], ['A', 's0', 'B'])
    const next = moveLayoutItems(base, ['A'], 'B', 'inside')
    expect(next).toEqual(layout([g('A', ['a1']), g('B', ['b1'])], ['s0', 'B', 'A']))
  })

  it('never nests a group: dropped on a row inside another group, it lands after that group', () => {
    const base = layout([g('A', ['a1']), g('B', ['b1', 'b2'])], ['A', 's0', 'B'])
    const next = moveLayoutItems(base, ['A'], 'b1', 'after')
    expect(next!.displayOrder).toEqual(['s0', 'B', 'A'])
    expect(next!.groups.map((x) => x.sessionIds)).toEqual([['a1'], ['b1', 'b2']])
  })

  it('refuses to move a group onto one of its own rows', () => {
    expect(moveLayoutItems(layout([g('A', ['a1', 'a2'])], ['A']), ['A'], 'a1', 'after')).toBeNull()
  })
})

describe('moveLayoutItems — repairs', () => {
  it('a row wrongly present in two groups ends up in one place only', () => {
    const next = moveLayoutItems(
      layout([g('A', ['x', 'a1']), g('B', ['x', 'b1'])], ['A', 'B']),
      ['x'],
      'b1',
      'after'
    )
    expect(next).toEqual(layout([g('A', ['a1']), g('B', ['b1', 'x'])], ['A', 'B']))
  })

  it('a nested row that also sat at the top level is removed from the top level', () => {
    const next = moveLayoutItems(
      layout([g('A', ['a1', 'a2'])], ['A', 'a1', 's0']),
      ['s0'],
      'A',
      'before'
    )
    expect(next).toEqual(layout([g('A', ['a1', 'a2'])], ['s0', 'A']))
  })

  it('a group the order forgot becomes reachable again', () => {
    const next = moveLayoutItems(
      layout([g('A', ['a1']), g('B', ['b1'])], ['A', 's0']),
      ['s0'],
      'A',
      'before'
    )
    expect(next!.displayOrder).toEqual(['s0', 'A', 'B'])
  })
})
