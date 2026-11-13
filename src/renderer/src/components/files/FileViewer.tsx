import { parseResourceKey, resourceKey } from '@clave/contract/fleet'
import { isRemoteKey } from '../../lib/fleet-identity'
import { useCallback, useState } from 'react'
import { useSessionStore, type FileTab } from '../../store/session-store'
import { FileContentRenderer } from './FileContentRenderer'
import { FileMenu } from './FileMenu'
import { FileInfoTooltip } from './FileInfoTooltip'
import { HTML_MODES, MARKDOWN_MODES } from './file-types'
import { useFileEditor } from '../../hooks/use-file-editor'
import { useFileViewMode } from '../../hooks/use-file-view-mode'
import { useCopyFeedback } from '../../hooks/use-copy-feedback'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  DocumentTextIcon,
  FolderIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'

const EXTERNAL_EXTS = new Set(['html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])

interface FileViewerProps {
  fileTab: FileTab
}

export function FileViewer({ fileTab }: FileViewerProps): React.JSX.Element {
  const removeFileTab = useSessionStore((s) => s.removeFileTab)

  const fileOwner = parseResourceKey('file', fileTab.filePath)
  const remote = isRemoteKey(fileTab.filePath)
  const rawPath = fileOwner.id
  const filename = rawPath.split('/').pop() ?? ''
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const canOpenExternally = EXTERNAL_EXTS.has(ext)
  // Extract cwd: everything up to the last path component
  const folder = rawPath.substring(0, rawPath.lastIndexOf('/')) || '/'
  const cwd = remote ? resourceKey('file', fileOwner.serverId, folder) : folder
  // Relative path for readFile: just the filename
  const relativePath = filename

  const editor = useFileEditor({ cwd, filePath: relativePath })
  const { fileData, content, isDirty, saving, canEdit, isImage, loadError, save } = editor
  const { isMarkdown, isHtml, viewMode, setViewMode } = useFileViewMode(
    fileTab.filePath,
    fileTab.view
  )

  const { copy } = useCopyFeedback()
  // A rendered .html page reloads on its own when the file changes; the
  // button is for the page that fetched something, or when in doubt.
  const [reloadKey, setReloadKey] = useState(0)
  // Copies the buffer you are looking at, unsaved edits included. Nothing to
  // copy for a binary, an image, or a file that failed to load.
  const canCopyContent = !!fileData && !fileData.binary && !isImage && !loadError

  const handleRevealInFinder = useCallback(() => {
    if (remote) return
    window.electronAPI?.showItemInFolder(fileTab.filePath)
  }, [fileTab.filePath, remote])

  const handleOpenExternally = useCallback(() => {
    if (remote) {
      void window.electronAPI.fleetDownload(
        resourceKey('file', fileOwner.serverId, '/'),
        rawPath,
        true
      )
      return
    }
    window.electronAPI?.openPath(fileTab.filePath)
  }, [fileTab.filePath, remote, fileOwner.serverId, rawPath])

  return (
    <div className="flex flex-col h-full bg-surface-0">
      {/* The bar: the session bar's classes, so the two are one control tall
          side by side (PRDCT-4491); the views and the rarer actions in the ⋯ menu. */}
      <header className="pane-header">
        <FileInfoTooltip cwd={cwd} filePath={relativePath} fileData={fileData} content={content}>
          <div className="pane-header-lead">
            <DocumentTextIcon className="w-4 h-4 text-text-tertiary flex-shrink-0" />
            <span className="pane-header-title flex-shrink-0 max-w-[40%]">{fileTab.name}</span>
            <span className="pane-header-meta hidden sm:inline">
              {rawPath.replace(/^\/Users\/[^/]+/, '~')}
            </span>
          </div>
        </FileInfoTooltip>
        <div className="pane-header-actions">
          {remote && (isMarkdown || isHtml) && <span className="pane-header-meta">Source</span>}
          {canEdit &&
            (isDirty || saving ? (
              <button
                onClick={save}
                disabled={saving}
                title="Save changes (⌘S)"
                className="flex items-center gap-1.5 flex-shrink-0 px-1 text-[11px] text-accent hover:opacity-80 transition-opacity disabled:opacity-60"
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent" />
                {saving ? 'Saving…' : 'Save'}
                {!saving && <span className="text-text-tertiary">⌘S</span>}
              </button>
            ) : (
              <span className="flex items-center gap-1 flex-shrink-0 px-1 text-[11px] text-text-tertiary">
                <CheckIcon className="w-3 h-3" />
                Saved
              </span>
            ))}
          {!remote && isHtml && viewMode === 'rendered' && (
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              className="panel-icon-btn"
              title="Reload"
              aria-label="Reload"
              data-testid="file-tab-reload"
            >
              <ArrowPathIcon className="w-4 h-4" />
            </button>
          )}
          <FileMenu
            views={remote ? [] : isMarkdown ? MARKDOWN_MODES : isHtml ? HTML_MODES : []}
            view={viewMode}
            onView={setViewMode}
            actions={[
              {
                id: 'copy',
                label: canCopyContent ? 'Copy contents' : 'Nothing to copy',
                icon: ClipboardDocumentIcon,
                disabled: !canCopyContent,
                done: 'Copied',
                onSelect: () => copy(content)
              },
              ...(canOpenExternally
                ? [
                    {
                      id: 'external',
                      label: 'Open externally',
                      icon: ArrowTopRightOnSquareIcon,
                      onSelect: handleOpenExternally
                    }
                  ]
                : []),
              ...(remote
                ? []
                : [
                    {
                      id: 'reveal',
                      label: 'Reveal in Finder',
                      icon: FolderIcon,
                      onSelect: handleRevealInFinder
                    }
                  ])
            ]}
          />
          <button
            onClick={() => removeFileTab(fileTab.id)}
            className="panel-icon-btn"
            title="Close"
            aria-label="Close file"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* File content */}
      <FileContentRenderer
        editor={editor}
        filePath={relativePath}
        cwd={cwd}
        viewMode={remote && isHtml ? 'source' : viewMode}
        reloadKey={reloadKey}
        className="flex-1"
      />
    </div>
  )
}
