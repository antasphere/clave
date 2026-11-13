import {
  ArrowTopRightOnSquareIcon,
  BookmarkSquareIcon,
  ClipboardDocumentIcon,
  CodeBracketIcon,
  DocumentTextIcon,
  FolderIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { LOCAL_SERVER_ID, resourceKey } from '@clave/contract/fleet'
import type { Artefact } from '@clave/contract/artefacts/model'
import { IconButton } from '@clave/ui/components'
import { useSessionStore } from '../../store/session-store'
import { ownerOfSession, useArtefactStore } from '../../store/artefact-store'
import { SlidelessArtefact } from './SlidelessArtefact'
import { ArtefactVersionChip } from './ArtefactVersionChip'
import { FileMenu } from './FileMenu'

/**
 * The panel a session's artefact lives in (PRDCT-4474), the other half of the
 * session's frame beside the conversation (see TerminalGrid), its body the
 * Slideless frame. Its bar is the session bar's height (PRDCT-4491) and
 * carries what Slideless's own bar did (PRDCT-4494): the version shown, in a
 * chip beside the title, and in the ⋯ menu Save version, the page's source as
 * a file tab of the machine the session runs on, and the file's place. Hiding
 * the panel keeps the artefact on its server; the chip in the session's
 * header brings it back.
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
  const noteSaved = useArtefactStore((s) => s.noteSaved)
  // The version controls need the machine's Slideless (PRDCT-4494); without it the card below says why.
  const owner = ownerOfSession(sessionId)
  const own = owner === LOCAL_SERVER_ID
  const ready = useArtefactStore((s) => s.slideless[owner]?.phase === 'ready')
  return (
    <section className="linked-document-panel" data-testid="artefact-panel">
      {/* The session bar's classes: one control tall beside the session's own bar (PRDCT-4491). */}
      <header className="pane-header">
        <div className="pane-header-lead" title={artefact.page}>
          <DocumentTextIcon className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
          <span className="pane-header-title">{artefact.title}</span>
          {ready && <ArtefactVersionChip sessionId={sessionId} />}
        </div>
        <div className="pane-header-actions">
          <FileMenu
            label="Artefact menu"
            actions={[
              {
                id: 'save-version',
                label: 'Save version',
                icon: BookmarkSquareIcon,
                disabled: !ready,
                reports: true,
                onSelect: async () => {
                  const saved = await window.electronAPI.artefacts.saveVersion(sessionId)
                  noteSaved(sessionId)
                  return saved.created
                    ? `Saved as v${saved.version}`
                    : `No change since v${saved.version}`
                }
              },
              {
                id: 'source',
                label: "Open the page's source",
                icon: CodeBracketIcon,
                separated: true,
                onSelect: () =>
                  addFileTab({
                    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    filePath: resourceKey('file', owner, artefact.page),
                    name: artefact.page.split('/').pop() ?? artefact.title
                  })
              },
              // The folder and the file are this Mac's only for a session of
              // this Mac: a server's artefact is a file of the server's disk.
              ...(own
                ? [
                    {
                      id: 'reveal',
                      label: 'Reveal in Finder',
                      icon: FolderIcon,
                      onSelect: () => window.electronAPI.showItemInFolder(artefact.page)
                    },
                    {
                      id: 'browser',
                      label: 'Open in browser',
                      icon: ArrowTopRightOnSquareIcon,
                      onSelect: () => void window.electronAPI.openPath(artefact.page)
                    }
                  ]
                : []),
              {
                id: 'copy-path',
                label: 'Copy path',
                icon: ClipboardDocumentIcon,
                done: 'Copied',
                onSelect: () => navigator.clipboard.writeText(artefact.page)
              }
            ]}
          />
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
