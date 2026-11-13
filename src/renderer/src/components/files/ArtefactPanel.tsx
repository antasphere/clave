import { CodeBracketIcon, DocumentTextIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { resourceKey } from '@clave/contract/fleet'
import type { Artefact } from '@clave/contract/artefacts/model'
import { IconButton } from '@clave/ui/components'
import { useSessionStore } from '../../store/session-store'
import { ownerOfSession, useArtefactStore } from '../../store/artefact-store'
import { SlidelessArtefact } from './SlidelessArtefact'

/**
 * The card a session's artefact lives in (PRDCT-4474), inset in the
 * session's frame beside the conversation (see TerminalGrid): the linked
 * document's shell and classes, its body the Slideless frame. The page's
 * source opens as a file tab of the machine the session runs on, the way
 * the file tree opens a file; hiding the card keeps the artefact on its
 * server, and the chip in the session's header brings it back.
 */
export function ArtefactPanel({
  sessionId,
  artefact
}: {
  sessionId: string
  artefact: Artefact
}): React.JSX.Element {
  const addFileTab = useSessionStore((s) => s.addFileTab)
  const setHidden = useArtefactStore((s) => s.setHidden)
  return (
    <section className="linked-document-panel" data-testid="artefact-panel">
      {/* The session bar's classes: one control tall beside the session's own bar (PRDCT-4491). */}
      <header className="pane-header">
        <div className="pane-header-lead" title={artefact.page}>
          <DocumentTextIcon className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
          <span className="pane-header-title">{artefact.title}</span>
        </div>
        <div className="pane-header-actions">
          <IconButton
            className="panel-icon-btn"
            tooltip="Open the page's source"
            aria-label="Open the page's source"
            onClick={() =>
              addFileTab({
                id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                filePath: resourceKey('file', ownerOfSession(sessionId), artefact.page),
                name: artefact.page.split('/').pop() ?? artefact.title
              })
            }
          >
            <CodeBracketIcon className="w-4 h-4" />
          </IconButton>
          <IconButton
            className="panel-icon-btn"
            tooltip="Hide artefact"
            aria-label="Hide artefact"
            onClick={() => setHidden(sessionId, artefact.openedAt)}
          >
            <XMarkIcon className="w-4 h-4" />
          </IconButton>
        </div>
      </header>
      <div className="linked-document-content">
        <SlidelessArtefact sessionId={sessionId} artefact={artefact} />
      </div>
    </section>
  )
}
