import { describe, expect, it } from 'vitest'
import { withoutGroup, withoutSession } from './sidebar-reflect'

const layout = {
  groups: [
    { id: 'g', name: 'Lanes', sessionIds: ['a', 'b'], terminals: [{ sessionId: 't' }] },
    { id: 'h', name: 'Other', sessionIds: ['c'], terminals: [] }
  ],
  displayOrder: ['g', 'h', 'x']
}

describe('reflecting a server-made change on a layout', () => {
  it('a tab moved away leaves its group, the order and the terminal that ran it', () => {
    const out = withoutSession(layout, 'b')
    expect(out.groups[0].sessionIds).toEqual(['a'])
    expect(withoutSession(layout, 't').groups[0].terminals).toEqual([{ sessionId: null }])
    expect(withoutSession(layout, 'x').displayOrder).toEqual(['g', 'h'])
    // Everything else is untouched, the name included.
    expect(out.groups[0].name).toBe('Lanes')
    expect(out.groups[1]).toEqual(layout.groups[1])
  })

  it('a group moved away leaves whole, and the tabs that stayed become rows once', () => {
    const out = withoutGroup(layout, 'g', ['b', 'x'])
    expect(out.groups.map((g) => g.id)).toEqual(['h'])
    expect(out.displayOrder).toEqual(['h', 'x', 'b'])
  })

  it('the same change on the base and on a copy with a pending rename leaves only the rename', () => {
    const renamed = {
      ...layout,
      groups: [{ ...layout.groups[0], name: 'Renamed meanwhile' }, layout.groups[1]]
    }
    const base = withoutSession(layout, 'b')
    const local = withoutSession(renamed, 'b')
    expect(JSON.stringify(local) === JSON.stringify(base)).toBe(false)
    expect(local.groups[0].name).toBe('Renamed meanwhile')
    expect({ ...local, groups: [{ ...local.groups[0], name: 'Lanes' }, local.groups[1]] }).toEqual(
      base
    )
  })
})
