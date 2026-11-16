import { isRemoteKey, ownedFilePath } from '../../lib/fleet-identity'
import { useEffect, useCallback, useRef } from 'react'
import { motion } from 'framer-motion'
import { useSessionStore } from '../../store/session-store'
import { FileContent } from './FileContent'
import { FileMenu } from './FileMenu'
import { FileInfoTooltip } from './FileInfoTooltip'
import { useFileEditor } from '../../hooks/use-file-editor'
import { useFileViewMode } from '../../hooks/use-file-view-mode'
import { useCopyFeedback } from '../../hooks/use-copy-feedback'
import {
  canOpenExternally as canOpenExternallyExt,
  formatSize,
  HTML_MODES,
  MARKDOWN_MODES
} from './file-types'
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  DocumentTextIcon,
  XMarkIcon,
  WindowIcon
} from '@heroicons/react/24/outline'

export function FilePreview(): React.JSX.Element | null {
  const previewFile = useSessionStore((s) => s.previewFile)
  const previewCwd = useSessionStore((s) => s.previewCwd)
  const previewSource = useSessionStore((s) => s.previewSource)
  const previewLocationId = useSessionStore((s) => s.previewLocationId)
  const setPreviewFile = useSessionStore((s) => s.setPreviewFile)
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const addFileTab = useSessionStore((s) => s.addFileTab)
  const fileTreeOpen = useSessionStore((s) => s.fileTreeOpen)
  const fileTreeWidth = useSessionStore((s) => s.fileTreeWidth)

  const focusedSession = sessions.find((s) => s.id === focusedSessionId)
  const cwd = previewCwd ?? focusedSession?.cwd ?? null

  const panelRef = useRef<HTMLDivElement>(null)

  const editor = useFileEditor({ cwd, filePath: previewFile, locationId: previewLocationId })
  const {
    fileData,
    filename,
    content,
    isDirty,
    canEdit,
    isImage,
    saving,
    saveError,
    loadError,
    save
  } = editor
  const { copy } = useCopyFeedback()
  // Copies the buffer you are looking at, unsaved edits included. Nothing to
  // copy for a binary, an image, or a file that failed to load.
  const canCopyContent = !!fileData && !fileData.binary && !isImage && !loadError
  // Remote files can't be served by the local preview protocol — pin them to source.
  const { isMarkdown, isHtml, viewMode, setViewMode } = useFileViewMode(
    previewFile,
    previewLocationId || isRemoteKey(cwd) ? 'source' : undefined
  )

  const canOpenExternally = canOpenExternallyExt(filename)

  const close = useCallback(() => {
    setPreviewFile(null)
  }, [setPreviewFile])

  const handleClose = useCallback(() => {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return
    close()
  }, [isDirty, close])

  const openInTab = useCallback(() => {
    if (!previewFile || !cwd) return
    const name = previewFile.split('/').pop() ?? previewFile
    addFileTab({
      id: isRemoteKey(cwd)
        ? ownedFilePath(cwd, previewFile)
        : `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      filePath: ownedFilePath(cwd, previewFile),
      name
    })
    close()
  }, [previewFile, cwd, addFileTab, close])

  const openExternally = useCallback(() => {
    if (!previewFile || !cwd) return
    window.electronAPI?.openPath(ownedFilePath(cwd, previewFile))
  }, [previewFile, cwd])

  // Keyboard: Escape closes; Cmd+S saves (skipped if the editor already handled it)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
        return
      }
      if (e.key === 's' && e.metaKey) {
        if (e.defaultPrevented) return
        e.preventDefault()
        if (canEdit && isDirty) save()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleClose, canEdit, isDirty, save])

  // Click-outside closes — but never while there are unsaved edits
  useEffect(() => {
    if (!previewFile) return
    const handleMouseDown = (e: MouseEvent): void => {
      // The bar's ⋯ menu draws in a portal, outside the sheet: a click on one
      // of its rows is the sheet's own (PRDCT-4491).
      if ((e.target as Element | null)?.closest?.('[data-radix-popper-content-wrapper]')) return
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        if (isDirty) return
        close()
      }
    }
    window.addEventListener('mousedown', handleMouseDown)
    return () => window.removeEventListener('mousedown', handleMouseDown)
  }, [previewFile, isDirty, close])

  if (!previewFile) return null

  // Position: floating overlay to the left of the tree panel
  const rightOffset = previewSource === 'tree' && fileTreeOpen ? fileTreeWidth + 8 : 16
  const panelWidth = 560

  return (
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0, width: panelWidth }}
      exit={{ opacity: 0, x: 8 }}
      transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
      className="menu-surface menu-surface--sheet fixed z-50 flex flex-col"
      style={
        {
          right: rightOffset,
          top: '10%',
          maxHeight: '75vh',
          width: panelWidth,
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties
      }
    >
      {/* The bar: the session bar's classes, one control tall (PRDCT-4491); the
          views and the rarer actions in the ⋯ menu. */}
      <header className="pane-header">
        <FileInfoTooltip cwd={cwd} filePath={previewFile} fileData={fileData} content={content}>
          <div className="pane-header-lead">
            <DocumentTextIcon className="w-4 h-4 text-text-tertiary flex-shrink-0" />
            <span className="pane-header-title flex-shrink-0 max-w-[50%]">{filename}</span>
            {previewFile !== filename && <span className="pane-header-meta">{previewFile}</span>}
          </div>
        </FileInfoTooltip>
        <div className="pane-header-actions">
          {isRemoteKey(cwd) && (isMarkdown || isHtml) && (
            <span className="pane-header-meta">Source</span>
          )}
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
          <button
            onClick={openInTab}
            className="panel-icon-btn"
            title="Open in tab"
            aria-label="Open in tab"
          >
            <WindowIcon className="w-4 h-4" />
          </button>
          <FileMenu
            views={
              isRemoteKey(cwd)
                ? []
                : isMarkdown
                  ? MARKDOWN_MODES
                  : isHtml && !previewLocationId
                    ? HTML_MODES
                    : []
            }
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
                      onSelect: openExternally
                    }
                  ]
                : [])
            ]}
          />
          <button
            onClick={handleClose}
            className="panel-icon-btn"
            title="Close"
            aria-label="Close preview"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        <FileContent
          editor={editor}
          cwd={cwd}
          filePath={previewFile}
          viewMode={isRemoteKey(cwd) && isHtml ? 'source' : viewMode}
        />

        {saveError && (
          <div className="px-4 py-1.5 text-xs text-red-400 bg-red-500/5 border-t border-border-subtle flex-shrink-0">
            {saveError}
          </div>
        )}

        {fileData?.truncated && (
          <div className="px-4 py-1.5 text-xs text-yellow-500 bg-yellow-500/5 border-t border-border-subtle flex-shrink-0">
            File truncated at 1MB ({formatSize(fileData.size)} total)
          </div>
        )}
      </div>
    </motion.div>
  )
}
