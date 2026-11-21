import { describe, expect, it } from 'vitest'
import {
  announcement,
  blockLabel,
  chipShown,
  fileUpdate,
  nextToAnnounce,
  spokenName,
  updateName,
  withoutSession,
  withoutUpdate,
  type Update
} from './updates'

const filed = (
  sessionId: string,
  pageKey: string,
  at: number
): Omit<Update, 'id' | 'announced'> => ({
  sessionId,
  pageKey,
  markdown: `Answer of ${sessionId} ${pageKey}`,
  title: `Title ${pageKey}`,
  at
})

describe('fileUpdate', () => {
  it('appends a new update, not announced, with its id', () => {
    const list = fileUpdate([], filed('a', 'p1', 1))
    expect(list).toEqual([{ ...filed('a', 'p1', 1), id: 'a|p1', announced: false }])
  })
  it('keeps one update per tab: the newest replaces it and moves to the end', () => {
    let list = fileUpdate([], filed('a', 'p1', 1))
    list = fileUpdate(list, filed('b', 'p1', 2))
    list = list.map((u) => ({ ...u, announced: true }))
    list = fileUpdate(list, filed('a', 'p5', 3))
    expect(list.map((u) => u.id)).toEqual(['b|p1', 'a|p5'])
    expect(list[1].announced).toBe(false)
    expect(list[0].announced).toBe(true)
  })
})

describe('withoutSession and withoutUpdate', () => {
  const list = fileUpdate(fileUpdate([], filed('a', 'p1', 1)), filed('b', 'p2', 2))
  it('drops the update of a tab', () => {
    expect(withoutSession(list, 'a').map((u) => u.id)).toEqual(['b|p2'])
  })
  it('gives the same list back when the tab had none', () => {
    expect(withoutSession(list, 'z')).toBe(list)
  })
  it('drops one update by id, the same list when absent', () => {
    expect(withoutUpdate(list, 'b|p2').map((u) => u.id)).toEqual(['a|p1'])
    expect(withoutUpdate(list, 'b|p9')).toBe(list)
  })
})

describe('nextToAnnounce', () => {
  it('is the oldest not announced', () => {
    let list = fileUpdate(fileUpdate([], filed('a', 'p1', 1)), filed('b', 'p2', 2))
    expect(nextToAnnounce(list)?.id).toBe('a|p1')
    list = list.map((u) => (u.id === 'a|p1' ? { ...u, announced: true } : u))
    expect(nextToAnnounce(list)?.id).toBe('b|p2')
    list = list.map((u) => ({ ...u, announced: true }))
    expect(nextToAnnounce(list)).toBeNull()
    expect(nextToAnnounce([])).toBeNull()
  })
})

describe('announcement', () => {
  it('names the group', () => {
    expect(announcement('Atlas')).toBe('I have an update for you on Atlas.')
  })
  it('trims the name', () => {
    expect(announcement('  Harbor  ')).toBe('I have an update for you on Harbor.')
  })
  it('keeps one final period when the name ends in punctuation', () => {
    expect(announcement('Harbor.')).toBe('I have an update for you on Harbor.')
    expect(announcement('Atlas!')).toBe('I have an update for you on Atlas.')
    expect(announcement('Atlas...')).toBe('I have an update for you on Atlas.')
    expect(announcement('What next?')).toBe('I have an update for you on What next.')
  })
})

describe('updateName', () => {
  const sessions = [
    { id: 'a', name: 'Draft notes' },
    { id: 'b', name: 'Loose tab' }
  ]
  const groups = [{ name: 'Atlas', sessionIds: ['a'] }]
  it('names the group the tab sits in, and the tab', () => {
    expect(updateName('a', sessions, groups)).toEqual({ group: 'Atlas', tab: 'Draft notes' })
    expect(spokenName(updateName('a', sessions, groups))).toBe('Atlas')
  })
  it('names the tab alone when it is in no group', () => {
    expect(updateName('b', sessions, groups)).toEqual({ group: null, tab: 'Loose tab' })
    expect(spokenName(updateName('b', sessions, groups))).toBe('Loose tab')
  })
  it('reads live: a rename shows at once', () => {
    const renamed = [{ name: 'Harbor', sessionIds: ['a'] }]
    expect(updateName('a', sessions, renamed).group).toBe('Harbor')
  })
})

describe('chipShown', () => {
  const list = fileUpdate(fileUpdate([], filed('a', 'p1', 1)), filed('b', 'p2', 2))
  it('is absent with nothing waiting and nothing read off screen', () => {
    expect(chipShown([], null)).toBeNull()
    expect(
      chipShown([], { sessionId: 'a', onScreen: true, reading: { state: 'playing' } })
    ).toBeNull()
  })
  it('waiting names the oldest, with how many more', () => {
    expect(chipShown(list, null)).toEqual({ state: 'waiting', sessionId: 'a', more: 1 })
  })
  it('an off-screen reading comes first, in its own state', () => {
    for (const state of ['preparing', 'playing', 'paused'] as const)
      expect(chipShown(list, { sessionId: 'c', onScreen: false, reading: { state } })).toEqual({
        state,
        sessionId: 'c',
        more: 2
      })
  })
  it('a reading on screen leaves the chip to the updates', () => {
    expect(
      chipShown(list, { sessionId: 'c', onScreen: true, reading: { state: 'playing' } })?.state
    ).toBe('waiting')
  })
})

describe('blockLabel', () => {
  it('counts from one and never past the last block', () => {
    expect(blockLabel({ tick: 0, blocks: 4 })).toBe('Block 1 of 4')
    expect(blockLabel({ tick: 3, blocks: 4 })).toBe('Block 4 of 4')
    expect(blockLabel({ tick: 9, blocks: 4 })).toBe('Block 4 of 4')
  })
})
