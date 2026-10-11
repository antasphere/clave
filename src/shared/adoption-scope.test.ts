import { describe, expect, it } from 'vitest'
import { savedLayoutSessionIds, selectAdoptableRecords } from './adoption-scope'

const records = [
  { id: 'own', windowKey: 'w1' },
  { id: 'other', windowKey: 'w2' },
  { id: 'unstamped' },
  { id: 'dead', windowKey: 'gone' }
]
const ids = (rs: { id: string }[]): string[] => rs.map((r) => r.id)

describe('which records a window brings back', () => {
  it('a secondary window takes only its own', () => {
    expect(
      ids(
        selectAdoptableRecords(records, {
          windowKey: 'w2',
          primary: false,
          knownWindowKeys: ['w1', 'w2']
        })
      )
    ).toEqual(['other'])
  })
  it('the primary takes its own and the orphans: unstamped, or stamped for a window nobody knows', () => {
    expect(
      ids(
        selectAdoptableRecords(records, {
          windowKey: 'w1',
          primary: true,
          knownWindowKeys: ['w1', 'w2']
        })
      )
    ).toEqual(['own', 'unstamped', 'dead'])
  })
  it('a window persisted for the next boot is known, so its records are not orphans', () => {
    expect(
      ids(
        selectAdoptableRecords(records, {
          windowKey: 'w1',
          primary: true,
          knownWindowKeys: ['w1', 'w2', 'gone']
        })
      )
    ).toEqual(['own', 'unstamped'])
  })
})

describe('the session ids a saved layout names (the attached restore gate)', () => {
  const layout = (over: Partial<import('./adoption-scope').SavedLayoutLike> = {}) => ({
    displayOrder: [] as string[],
    groups: [] as { sessionIds: string[]; terminals: { sessionId: string | null }[] }[],
    ...over
  })
  it('is empty for a window that reopens with nothing (the fresh-app case)', () => {
    expect(savedLayoutSessionIds(layout())).toEqual([])
  })
  it('names a top-level tab', () => {
    expect(savedLayoutSessionIds(layout({ displayOrder: ['t1'] }))).toEqual(['t1'])
  })
  it('names a group member', () => {
    expect(
      savedLayoutSessionIds(layout({ groups: [{ sessionIds: ['m1'], terminals: [] }] }))
    ).toEqual(['m1'])
  })
  it('names a group quick-launch terminal — a group-terminal-only window still restores', () => {
    expect(
      savedLayoutSessionIds(
        layout({ groups: [{ sessionIds: [], terminals: [{ sessionId: 'term1' }] }] })
      )
    ).toEqual(['term1'])
  })
  it('skips a terminal with no live session, and dedups across the three places', () => {
    expect(
      savedLayoutSessionIds({
        displayOrder: ['a'],
        groups: [{ sessionIds: ['a', 'b'], terminals: [{ sessionId: null }, { sessionId: 'b' }] }]
      }).sort()
    ).toEqual(['a', 'b'])
  })
})
