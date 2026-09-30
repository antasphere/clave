import { useCallback, useState } from 'react'
import { useSessionStore, type FileTab } from '../../store/session-store'
import { FileContentRenderer } from './FileContentRenderer'
import { ViewModeToggle } from './ViewModeToggle'
import { FileInfoTooltip } from './FileInfoTooltip'
import { HTML_MODES } from './file-types'
import { useFileEditor } from '../../hooks/use-file-editor'
import { useFileViewMode } from '../../hooks/use-file-view-mode'
import { useCopyFeedback } from '../../hooks/use-copy-feedback'
import { cn } from '@clave/ui/components'
import { DocumentTextIcon, CheckIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import {
  CopyIcon,
  FolderIcon,
  ExternalLinkIcon,
  CloseIcon,
  fileActionButtonClass
} from './FileActionIcons'

const EXTERNAL_EXTS = new Set(['html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])

interface FileViewerProps {
  fileTab: FileTab
}

export function FileViewer({ fileTab }: FileViewerProps): React.JSX.Element {
  const removeFileTab = useSessionStore((s) => s.removeFileTab)

  const filename = fileTab.filePath.split('/').pop() ?? ''
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const canOpenExternally = EXTERNAL_EXTS.has(ext)
  // Extract cwd: everything up to the last path component
  const cwd = fileTab.filePath.substring(0, fileTab.filePath.lastIndexOf('/')) || '/'
  // Relative path for readFile: just the filename
  const relativePath = filename

  const editor = useFileEditor({ cwd, filePath: relativePath })
  const { fileData, content, isDirty, saving, canEdit, isImage, loadError, save } = editor
  const { isMarkdown, isHtml, viewMode, setViewMode } = useFileViewMode(
    fileTab.filePath,
    fileTab.view
  )

  const { copied, copy } = useCopyFeedback()
  // A rendered .html page reloads on its own when the file changes; the
  // button is for the page that fetched something, or when in doubt.
  const [reloadKey, setReloadKey] = useState(0)
  // Copies the buffer you are looking at, unsaved edits included. Nothing to
  // copy for a binary, an image, or a file that failed to load.
  const canCopyContent = !!fileData && !fileData.binary && !isImage && !loadError

  const handleRevealInFinder = useCallback(() => {
    window.electronAPI?.showItemInFolder(fileTab.filePath)
  }, [fileTab.filePath])

  const handleOpenExternally = useCallback(() => {
    window.electronAPI?.openPath(fileTab.filePath)
  }, [fileTab.filePath])

  return (
    <div className="flex flex-col h-full bg-surface-0">
      {/* Header bar: name + path, view mode, save state, actions — one row */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle flex-shrink-0">
        <FileInfoTooltip cwd={cwd} filePath={relativePath} fileData={fileData} content={content}>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <DocumentTextIcon className="w-4 h-4 text-text-tertiary flex-shrink-0" />
            <span className="text-sm font-medium text-text-primary truncate flex-shrink-0 max-w-[40%]">
              {fileTab.name}
            </span>
            <span className="text-[11px] text-text-tertiary truncate hidden sm:inline flex-1 min-w-0">
              {fileTab.filePath.replace(/^\/Users\/[^/]+/, '~')}
            </span>
          </div>
        </FileInfoTooltip>
        {isMarkdown && <ViewModeToggle mode={viewMode} onChange={setViewMode} />}
        {isHtml && <ViewModeToggle mode={viewMode} onChange={setViewMode} modes={HTML_MODES} />}
        {canEdit &&
          (isDirty || saving ? (
            <button
              onClick={save}
              disabled={saving}
              title="Save changes (⌘S)"
              className="flex items-center gap-1.5 flex-shrink-0 text-[11px] text-accent hover:opacity-80 transition-opacity disabled:opacity-60"
            >
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent" />
              {saving ? 'Saving…' : 'Save'}
              {!saving && <span className="text-text-tertiary">⌘S</span>}
            </button>
          ) : (
            <span className="flex items-center gap-1 flex-shrink-0 text-[11px] text-text-tertiary">
              <CheckIcon className="w-3 h-3" />
              Saved
            </span>
          ))}
        <div className="flex items-center gap-1 flex-shrink-0">
          {isHtml && viewMode === 'rendered' && (
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              className={fileActionButtonClass}
              title="Reload"
              data-testid="file-tab-reload"
            >
              <ArrowPathIcon className="w-3 h-3" />
            </button>
          )}
          {canOpenExternally && (
            <button
              onClick={handleOpenExternally}
              className={fileActionButtonClass}
              title="Open externally"
            >
              <ExternalLinkIcon />
            </button>
          )}
          <button
            onClick={() => copy(content)}
            disabled={!canCopyContent}
            className={cn(fileActionButtonClass, copied && 'text-status-ready')}
            title={canCopyContent ? 'Copy contents' : 'Nothing to copy'}
          >
            {copied ? <CheckIcon className="w-3 h-3" /> : <CopyIcon />}
          </button>
          <button
            onClick={handleRevealInFinder}
            className={fileActionButtonClass}
            title="Reveal in Finder"
          >
            <FolderIcon />
          </button>
          <button
            onClick={() => removeFileTab(fileTab.id)}
            className={fileActionButtonClass}
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {/* File content */}
      <FileContentRenderer
        editor={editor}
        filePath={relativePath}
        cwd={cwd}
        viewMode={viewMode}
        reloadKey={reloadKey}
        className="flex-1"
      />
    </div>
  )
}
