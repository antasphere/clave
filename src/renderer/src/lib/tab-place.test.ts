import { describe, expect, it } from 'vitest'
import { groupPlaceOf, restoreGroupPlace, restoreTabPlace, tabPlaceOf } from './tab-place'
import type { Session, SessionGroup } from '../store/session-types'

const tab = (id: string): Session => ({ id, name: id }) as unknown as Session
const group = (
  id: string,
  sessionIds: string[],
  terminals: SessionGroup['terminals'] = []
): SessionGroup =>
  ({ id, name: id, sessionIds, terminals, collapsed: false, cwd: null }) as SessionGroup

describe('a tab whose close failed goes back where it sat (PRDCT-5315)', () => {
  it('inside its group, after the row that preceded it', () => {
    const before = {
      sessions: [tab('a'), tab('b'), tab('c')],
      groups: [group('g', ['a', 'b', 'c'])],
      displayOrder: ['g']
    }
    const place = tabPlaceOf(before, 'b')!
    expect(place).toMatchObject({ groupId: 'g', after: 'a', index: 1 })
    const closed = {
      sessions: [tab('a'), tab('c')],
      groups: [group('g', ['a', 'c'])],
      displayOrder: ['g']
    }
    const back = restoreTabPlace(closed, place)
    expect(back.groups[0].sessionIds).toEqual(['a', 'b', 'c'])
    expect(back.sessions.map((s) => s.id)).toEqual(['a', 'c', 'b'])
  })

  it('at the top level, after its neighbour, even when rows came in meanwhile', () => {
    const before = { sessions: [tab('x'), tab('y')], groups: [], displayOrder: ['x', 'y'] }
    const place = tabPlaceOf(before, 'y')!
    const meanwhile = { sessions: [tab('new'), tab('x')], groups: [], displayOrder: ['new', 'x'] }
    expect(restoreTabPlace(meanwhile, place).displayOrder).toEqual(['new', 'x', 'y'])
  })

  it('first of its container when it was first', () => {
    const before = { sessions: [tab('x'), tab('y')], groups: [], displayOrder: ['x', 'y'] }
    const place = tabPlaceOf(before, 'x')!
    const closed = { sessions: [tab('y')], groups: [], displayOrder: ['y'] }
    expect(restoreTabPlace(closed, place).displayOrder).toEqual(['x', 'y'])
  })

  it('at its index when its neighbour is gone too', () => {
    const before = {
      sessions: [tab('a'), tab('b'), tab('c'), tab('d')],
      groups: [],
      displayOrder: ['a', 'b', 'c', 'd']
    }
    const place = tabPlaceOf(before, 'c')!
    const closed = { sessions: [tab('a'), tab('d')], groups: [], displayOrder: ['a', 'd'] }
    expect(restoreTabPlace(closed, place).displayOrder).toEqual(['a', 'd', 'c'])
  })

  it('at the top of the sidebar when its group was deleted meanwhile', () => {
    const before = {
      sessions: [tab('a'), tab('b'), tab('z')],
      groups: [group('g', ['a', 'b'])],
      displayOrder: ['g', 'z']
    }
    const place = tabPlaceOf(before, 'b')!
    const closed = { sessions: [tab('z')], groups: [], displayOrder: ['z'] }
    const back = restoreTabPlace(closed, place)
    expect(back.displayOrder).toEqual(['b', 'z'])
    expect(back.sessions.map((s) => s.id)).toContain('b')
  })

  it('back in its group terminal slot', () => {
    const slot = { id: 't1', command: 'npm run dev', commandMode: 'auto', color: 'green' }
    const before = {
      sessions: [tab('a'), tab('dev')],
      groups: [group('g', ['a'], [{ ...slot, sessionId: 'dev' } as never])],
      displayOrder: ['g']
    }
    const place = tabPlaceOf(before, 'dev')!
    expect(place.terminal).toEqual({ groupId: 'g', terminalId: 't1' })
    const closed = {
      sessions: [tab('a')],
      groups: [group('g', ['a'], [{ ...slot, sessionId: null } as never])],
      displayOrder: ['g']
    }
    const back = restoreTabPlace(closed, place)
    expect(back.groups[0].terminals[0].sessionId).toBe('dev')
    expect(back.displayOrder).toEqual(['g'])
    expect(back.groups[0].sessionIds).toEqual(['a'])
  })

  it('keeps the row a snapshot already put back, and never duplicates the tab', () => {
    const before = { sessions: [tab('x'), tab('y')], groups: [], displayOrder: ['x', 'y'] }
    const place = tabPlaceOf(before, 'y')!
    const relisted = { sessions: [tab('y'), tab('x')], groups: [], displayOrder: ['y', 'x'] }
    const back = restoreTabPlace(relisted, place)
    expect(back.displayOrder).toEqual(['y', 'x'])
    expect(back.sessions.filter((s) => s.id === 'y')).toHaveLength(1)
  })

  it('an unknown tab has no place', () => {
    expect(tabPlaceOf({ sessions: [], groups: [], displayOrder: [] }, 'nope')).toBeNull()
  })
})

describe('a deleted group comes back around the tabs whose close failed (PRDCT-5315)', () => {
  const slot = (id: string, sessionId: string | null): never =>
    ({ id, command: 'npm run dev', commandMode: 'auto', color: 'green', sessionId }) as never

  it('in its place, holding only those tabs, in their order, the closed slots emptied', () => {
    const before = {
      sessions: [tab('x'), tab('a'), tab('b'), tab('c'), tab('dev'), tab('y')],
      groups: [group('g', ['a', 'b', 'c'], [slot('t', 'dev')])],
      displayOrder: ['x', 'g', 'y']
    }
    const place = groupPlaceOf(before, 'g')!
    // The group is gone; a and c came back at the top level with their marks.
    const after = {
      sessions: [tab('x'), tab('a'), tab('c'), tab('y')],
      groups: [],
      displayOrder: ['a', 'c', 'x', 'y']
    }
    const back = restoreGroupPlace(after, place, new Set(['c', 'a']))
    expect(back.displayOrder).toEqual(['x', 'g', 'y'])
    expect(back.groups).toHaveLength(1)
    expect(back.groups[0].sessionIds).toEqual(['a', 'c'])
    expect(back.groups[0].terminals[0].sessionId).toBeNull()
  })

  it('keeps a terminal slot whose close failed', () => {
    const before = {
      sessions: [tab('dev')],
      groups: [group('g', [], [slot('t', 'dev')])],
      displayOrder: ['g']
    }
    const place = groupPlaceOf(before, 'g')!
    const back = restoreGroupPlace(
      { sessions: [tab('dev')], groups: [], displayOrder: ['dev'] },
      place,
      new Set(['dev'])
    )
    expect(back.groups[0].terminals[0].sessionId).toBe('dev')
    expect(back.displayOrder).toEqual(['g'])
  })

  it('never brings back a tab the store no longer holds, nor a group around nothing', () => {
    const before = {
      sessions: [tab('a'), tab('b')],
      groups: [group('g', ['a', 'b'])],
      displayOrder: ['g']
    }
    const place = groupPlaceOf(before, 'g')!
    const gone = { sessions: [tab('b')], groups: [], displayOrder: ['b'] }
    expect(restoreGroupPlace(gone, place, new Set(['a']))).toBe(gone)
  })

  it('a later refusal joins the group an earlier one brought back, in the old order', () => {
    const before = {
      sessions: [tab('a'), tab('b'), tab('c')],
      groups: [group('g', ['a', 'b', 'c'])],
      displayOrder: ['g']
    }
    const place = groupPlaceOf(before, 'g')!
    const firstBack = {
      sessions: [tab('a'), tab('c')],
      groups: [group('g', ['c'])],
      displayOrder: ['a', 'g']
    }
    const back = restoreGroupPlace(firstBack, place, new Set(['a']))
    expect(back.groups[0].sessionIds).toEqual(['a', 'c'])
    expect(back.displayOrder).toEqual(['g'])
  })

  it('leaves a group that is already back as it is', () => {
    const state = { sessions: [tab('a')], groups: [group('g', ['a'])], displayOrder: ['g'] }
    const place = groupPlaceOf(state, 'g')!
    expect(restoreGroupPlace(state, place, new Set(['a']))).toBe(state)
  })
})

describe('a group already back keeps what the person made of it (PRDCT-5315, round 2)', () => {
  const slot = (id: string, sessionId: string | null): never =>
    ({ id, command: 'npm run dev', commandMode: 'auto', color: 'green', sessionId }) as never
  const before = {
    sessions: [tab('a'), tab('b'), tab('c'), tab('dev')],
    groups: [group('g', ['a', 'b', 'c'], [slot('t', 'dev')])],
    displayOrder: ['x', 'g']
  }
  const place = groupPlaceOf(before, 'g')!

  it('puts a tab already in it back in the old order', () => {
    const misplaced = {
      sessions: [tab('a'), tab('b')],
      groups: [group('g', ['b', 'a'])],
      displayOrder: ['x', 'g']
    }
    expect(restoreGroupPlace(misplaced, place, new Set(['b'])).groups[0].sessionIds).toEqual([
      'a',
      'b'
    ])
  })

  it('keeps a row the person added to it', () => {
    const added = {
      sessions: [tab('a'), tab('mine'), tab('c')],
      groups: [group('g', ['a', 'mine'])],
      displayOrder: ['g', 'c']
    }
    expect(restoreGroupPlace(added, place, new Set(['c'])).groups[0].sessionIds).toEqual([
      'a',
      'c',
      'mine'
    ])
  })

  it('keeps a terminal slot an earlier refusal filled', () => {
    const filled = {
      sessions: [tab('dev'), tab('b')],
      groups: [group('g', [], [slot('t', 'dev')])],
      displayOrder: ['g', 'b']
    }
    expect(restoreGroupPlace(filled, place, new Set(['b'])).groups[0].terminals[0].sessionId).toBe(
      'dev'
    )
  })

  it('keeps the place the person moved it to', () => {
    const moved = {
      sessions: [tab('a'), tab('c'), tab('x')],
      groups: [group('g', ['a'])],
      displayOrder: ['g', 'x', 'c']
    }
    expect(restoreGroupPlace(moved, place, new Set(['c'])).displayOrder).toEqual(['g', 'x'])
  })

  it('keeps the name the person gave it', () => {
    const renamed = {
      sessions: [tab('a'), tab('c')],
      groups: [{ ...group('g', ['a']), name: 'Mine now' }],
      displayOrder: ['g', 'c']
    }
    expect(restoreGroupPlace(renamed, place, new Set(['c'])).groups[0].name).toBe('Mine now')
  })
})
