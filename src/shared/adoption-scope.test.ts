import { describe, expect, it } from 'vitest'
import { selectAdoptableRecords } from './adoption-scope'

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
