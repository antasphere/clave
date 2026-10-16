import { useEffect, useState } from 'react'
import { parseResourceKey, resourceKey } from '@clave/contract/fleet'
import { isRemoteKey } from '../../lib/fleet-identity'
import { CodeEditor } from './CodeEditor'
import { MarkdownRenderer } from './MarkdownRenderer'
import { MarkdownPageEditor } from './MarkdownPageEditor'
import { HtmlPage } from './HtmlPage'
import { formatSize, isHtmlFile, isMarkdownFile, type FileViewMode } from './file-types'
import type { useFileEditor } from '../../hooks/use-file-editor'

interface FileContentProps {
  editor: ReturnType<typeof useFileEditor>
  cwd: string | null
  filePath: string | null
  /** How markdown renders: page (document column), preview (compact), source (editor). Owned by the header's ViewModeToggle. */
  viewMode?: FileViewMode
  /** Bumped by the header's Reload button; reloads a rendered .html page. */
  reloadKey?: number
}

/**
 * Shared body for the file preview panel and the file tab. Branches by file
 * kind and renders the always-live CodeEditor for code. Markdown renders per
 * the controlled viewMode (source shows the same editable buffer).
 */
export function FileContent({
  editor,
  cwd,
  filePath,
  viewMode = 'page',
  reloadKey
}: FileContentProps): React.JSX.Element {
  const { fileData, filename, content, setContent, canEdit, isImage, loadError, save } = editor
  const isMarkdown = filePath ? isMarkdownFile(filename) : false
  const isHtml = filePath ? isHtmlFile(filename) : false
  // An empty file has nothing to click: the page editor's entire target is one
  // blank line, and a code editor's is one blank gutter row. The only way a
  // file is empty on this surface is that it was just created, so it opens with
  // the caret already in it — you name a document and you type.
  const autoFocus = !!fileData && !fileData.binary && content === ''

  if (loadError) {
    return (
      <div className="px-4 py-8 text-center text-sm text-text-tertiary">Failed to load file</div>
    )
  }

  if (isImage && filePath && cwd && isRemoteKey(cwd))
    return <FleetImage key={`${cwd}/${filePath}`} cwd={cwd} filePath={filePath} name={filename} />
  if (isImage && filePath) {
    const src = filePath.startsWith('/') ? `file://${filePath}` : `file://${cwd}/${filePath}`
    return (
      <div className="p-4 flex items-center justify-center">
        <img src={src} alt={filename} className="max-w-full max-h-[50vh] object-contain rounded" />
      </div>
    )
  }

  // HTML, rendered as a live page — served by the clave-preview protocol, so
  // this works for any size file (the 1MB editor cap below applies to source
  // mode only, where the same editable buffer as any code file takes over).
  if (isHtml && viewMode === 'rendered' && filePath) {
    const abs = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
    return (
      <div className="flex-1 min-h-0">
        <HtmlPage filePath={abs} reloadKey={reloadKey} />
      </div>
    )
  }

  if (!fileData) {
    return <div className="px-4 py-8 text-center text-sm text-text-tertiary">Loading…</div>
  }

  if (fileData.binary) {
    return (
      <div className="px-4 py-8 text-center text-sm text-text-tertiary">
        Binary file &mdash; cannot preview
        <div className="mt-1 text-xs">{formatSize(fileData.size)}</div>
      </div>
    )
  }

  if (fileData.size > 1024 * 1024) {
    return (
      <div className="px-4 py-8 text-center text-sm text-text-tertiary">
        File too large to preview
        <div className="mt-1 text-xs">{formatSize(fileData.size)}</div>
      </div>
    )
  }

  // Markdown page — directly editable (Notion-style) when the file is writable
  if (isMarkdown && viewMode === 'page' && canEdit) {
    return (
      <div className="flex-1 overflow-auto min-h-0">
        <MarkdownPageEditor
          key={`${cwd}/${filePath}`}
          content={content}
          onChange={setContent}
          onSave={save}
          autoFocus={autoFocus}
        />
      </div>
    )
  }

  // Markdown, rendered read-only (compact preview, or page for non-writable files)
  if (isMarkdown && viewMode !== 'source') {
    return (
      <div className="flex-1 overflow-auto min-h-0">
        <MarkdownRenderer
          content={content}
          variant={viewMode === 'page' ? 'page' : 'compact'}
          frontmatter
        />
      </div>
    )
  }

  // Code (and markdown source) — always-live editor
  return (
    <CodeEditor
      value={content}
      onChange={setContent}
      filename={filename}
      readOnly={!canEdit}
      onSave={save}
      autoFocus={autoFocus && canEdit}
      className="flex-1 min-h-0"
    />
  )
}

function FleetImage({
  cwd,
  filePath,
  name
}: {
  cwd: string
  filePath: string
  name: string
}): React.JSX.Element {
  const [image, setImage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    const root = parseResourceKey('file', cwd)
    const path = filePath.startsWith('/') ? filePath : `${root.id.replace(/\/$/, '')}/${filePath}`
    void window.electronAPI.readImageAsDataUrl(resourceKey('file', root.serverId, path)).then(
      (value) => {
        if (current) {
          setImage(value)
          setFailed(!value)
        }
      },
      () => {
        if (current) setFailed(true)
      }
    )
    return () => {
      current = false
    }
  }, [cwd, filePath])
  return image ? (
    <div className="p-4 flex justify-center">
      <img src={image} alt={name} className="max-w-full max-h-[50vh] object-contain" />
    </div>
  ) : (
    <p className="p-4 text-xs text-text-secondary">
      {failed ? 'Could not preview this image on the server.' : 'Loading image…'}
    </p>
  )
}
