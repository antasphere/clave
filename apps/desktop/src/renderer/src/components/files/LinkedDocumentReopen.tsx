import { DocumentTextIcon, EnvelopeIcon } from '@heroicons/react/24/outline'
import { useLinkedDocumentStore } from '../../store/linked-document-store'
import { useSessionStore } from '../../store/session-store'

/**
 * A hidden linked document stays one click away: a chip naming it in the
 * session's own header, the way an artifact chip sits in its conversation.
 * Shown only where the card can actually open — the session alone in the pane
 * (see `linkedActive` in TerminalGrid).
 */
export function LinkedDocumentReopen({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const doc = useLinkedDocumentStore((s) =>
    s.documents.find((d) => d.sessionId === sessionId && d.hidden)
  )
  const alone = useSessionStore(
    (s) => s.selectedSessionIds.length === 1 && s.selectedSessionIds[0] === sessionId
  )
  if (!doc || !alone) return null
  return (
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
  )
}
