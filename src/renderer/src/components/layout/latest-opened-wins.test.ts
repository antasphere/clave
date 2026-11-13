import { describe, expect, it } from 'vitest'
import { latestOpenedWins, type PaneDocument, type PaneLook } from './latest-opened-wins'

/** One card beside a session at a time, the one opened last (PRDCT-4474). */
const doc = (sessionId: string, hidden = false, revision = 1): PaneDocument => ({
  id: `doc-${sessionId}`,
  sessionId,
  revision,
  hidden
})
const look = (documents: PaneDocument[], shown: string[]): PaneLook => ({
  documents,
  shownArtefacts: new Set(shown)
})

describe('the latest opened wins', () => {
  it('an artefact opened hides the session’s document that was showing', () => {
    expect(
      latestOpenedWins(look([doc('s1', false, 4)], []), look([doc('s1', false, 4)], ['s1']))
    ).toEqual({ hideDocuments: [{ id: 'doc-s1', revision: 4 }], hideArtefacts: [] })
  })

  it('a document that becomes visible hides the session’s artefact', () => {
    // Absent before, then there and not hidden.
    expect(latestOpenedWins(look([], ['s1']), look([doc('s1')], ['s1']))).toEqual({
      hideDocuments: [],
      hideArtefacts: ['s1']
    })
    // Hidden before, shown again by the person.
    expect(latestOpenedWins(look([doc('s1', true)], ['s1']), look([doc('s1')], ['s1']))).toEqual({
      hideDocuments: [],
      hideArtefacts: ['s1']
    })
  })

  it('touches nothing when nothing was newly shown, and nothing of another session', () => {
    const steady = look([doc('s1'), doc('s2', true)], ['s2'])
    expect(latestOpenedWins(steady, steady)).toEqual({ hideDocuments: [], hideArtefacts: [] })
    expect(latestOpenedWins(look([doc('s1')], []), look([doc('s1')], ['s2']))).toEqual({
      hideDocuments: [],
      hideArtefacts: []
    })
    // A document that becomes visible where no artefact shows hides nothing.
    expect(latestOpenedWins(look([], []), look([doc('s1')], []))).toEqual({
      hideDocuments: [],
      hideArtefacts: []
    })
  })

  it('both newly shown in one look: the artefact wins, once', () => {
    expect(latestOpenedWins(look([], []), look([doc('s1')], ['s1']))).toEqual({
      hideDocuments: [{ id: 'doc-s1', revision: 1 }],
      hideArtefacts: []
    })
  })
})
