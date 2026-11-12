/**
 * One card beside a session at a time (PRDCT-4474): its linked document or
 * its artefact, whichever was opened last. Judged on what changed between
 * two looks at the pane, never on the look itself, so a document the person
 * reopens wins over the artefact shown before it, and an artefact the agent
 * opens wins over the document.
 */
export interface PaneDocument {
  readonly id: string
  readonly sessionId: string
  readonly revision: number
  readonly hidden: boolean
}

export interface PaneLook {
  readonly documents: readonly PaneDocument[]
  /** The sessions whose artefact shows. */
  readonly shownArtefacts: ReadonlySet<string>
}

export interface PaneChange {
  /** Documents to hide: their session's artefact has just been shown. */
  readonly hideDocuments: ReadonlyArray<{ id: string; revision: number }>
  /** Sessions whose artefact to hide: their document has just become visible. */
  readonly hideArtefacts: readonly string[]
}

const visibleDocuments = (look: PaneLook): Map<string, PaneDocument> =>
  new Map(look.documents.filter((d) => !d.hidden).map((d) => [d.sessionId, d]))

export function latestOpenedWins(previous: PaneLook, next: PaneLook): PaneChange {
  const before = visibleDocuments(previous)
  const after = visibleDocuments(next)
  const hideDocuments: Array<{ id: string; revision: number }> = []
  const hideArtefacts: string[] = []
  for (const sessionId of next.shownArtefacts) {
    if (previous.shownArtefacts.has(sessionId)) continue
    const doc = after.get(sessionId)
    if (doc) hideDocuments.push({ id: doc.id, revision: doc.revision })
  }
  for (const [sessionId] of after) {
    if (before.has(sessionId) || !next.shownArtefacts.has(sessionId)) continue
    // Both newly shown at the same look: the artefact has already won above.
    if (hideDocuments.some((d) => after.get(sessionId)?.id === d.id)) continue
    hideArtefacts.push(sessionId)
  }
  return { hideDocuments, hideArtefacts }
}
