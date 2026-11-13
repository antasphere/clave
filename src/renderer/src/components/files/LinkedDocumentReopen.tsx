import { DocumentTextIcon, EnvelopeIcon } from '@heroicons/react/24/outline'
import { useLinkedDocumentStore } from '../../store/linked-document-store'
import { useArtefactStore } from '../../store/artefact-store'
import { useSessionStore } from '../../store/session-store'

/**
 * A hidden linked document stays one click away: a chip naming it in the
 * session's own header, the way an artifact chip sits in its conversation.
 * A hidden artefact (PRDCT-4474) has the same chip beside it. Shown only
 * where the card can actually open: the session alone in the pane (see
 * `linkedActive` in TerminalGrid).
 */
export function LinkedDocumentReopen({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const doc = useLinkedDocumentStore((s) =>
    s.documents.find((d) => d.sessionId === sessionId && d.hidden)
  )
  const artefact = useArtefactStore((s) => {
    const shown = s.artefacts[sessionId]
    return shown && s.hidden[sessionId] === shown.openedAt ? shown : undefined
  })
  const showArtefact = useArtefactStore((s) => s.setHidden)
  const alone = useSessionStore(
    (s) => s.selectedSessionIds.length === 1 && s.selectedSessionIds[0] === sessionId
  )
  if ((!doc && !artefact) || !alone) return null
  return (
    <>
      {doc && (
        <button
          className="panel-tab linked-document-reopen"
          aria-label="Open linked document"
          title={doc.path ?? doc.title}
          onClick={() => {
            void window.electronAPI.linkedDocuments.update(doc.id, doc.revision, { hidden: false })
          }}
        >
          {doc.email ? (
            <EnvelopeIcon className="w-3.5 h-3.5 flex-shrink-0" />
          ) : (
            <DocumentTextIcon className="w-3.5 h-3.5 flex-shrink-0" />
          )}
          <span className="truncate min-w-0">{doc.title}</span>
        </button>
      )}
      {artefact && (
        <button
          className="panel-tab linked-document-reopen"
          aria-label="Open artefact"
          title={artefact.page}
          onClick={() => showArtefact(sessionId, null)}
        >
          <DocumentTextIcon className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate min-w-0">{artefact.title}</span>
        </button>
      )}
    </>
  )
}
