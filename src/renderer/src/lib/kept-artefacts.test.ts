import { describe, expect, it } from 'vitest'
import { nextKept, type KeptArtefacts } from './kept-artefacts'

const walk = (
  shown: (string | null)[],
  limit = 4,
  valid: (id: string) => boolean = () => true
): { state: KeptArtefacts; drawn: string[][] } => {
  let state: KeptArtefacts = { kept: [], recent: [] }
  const drawn: string[][] = []
  for (const id of shown) {
    state = nextKept(state, id, valid, limit)
    drawn.push(state.kept)
  }
  return { state, drawn }
}

describe('the artefacts a pane keeps mounted (PRDCT-4474)', () => {
  it('draws the frames in the order each was first shown, whatever is shown since', () => {
    // The order of the frames never changes as tabs change: a moved iframe loads again.
    const { drawn } = walk(['A', 'B', 'A', 'B', 'A', 'C', 'A'])
    expect(drawn).toEqual([
      ['A'],
      ['A', 'B'],
      ['A', 'B'],
      ['A', 'B'],
      ['A', 'B'],
      ['A', 'B', 'C'],
      ['A', 'B', 'C']
    ])
  })

  it('lets the least recently shown go past the bound, the others keeping their place', () => {
    expect(walk(['A', 'B', 'C'], 2).state).toEqual({ kept: ['B', 'C'], recent: ['C', 'B'] })
    expect(walk(['A', 'B', 'A', 'C'], 2).state).toEqual({ kept: ['A', 'C'], recent: ['C', 'A'] })
  })

  it('lets go at once of a session closed, hidden or of another workspace', () => {
    expect(walk(['A', 'B', 'C'], 4, (id) => id !== 'B').state.kept).toEqual(['A', 'C'])
  })

  it('keeps what it has when nothing is shown alone', () => {
    expect(walk(['A', 'B', null]).state.kept).toEqual(['A', 'B'])
  })
})
