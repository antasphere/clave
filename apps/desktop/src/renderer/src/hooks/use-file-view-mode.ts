import { useState } from 'react'
import { isHtmlFile, isMarkdownFile, type FileViewMode } from '../components/files/file-types'

interface UseFileViewMode {
  isMarkdown: boolean
  isHtml: boolean
  viewMode: FileViewMode
  setViewMode: (mode: FileViewMode) => void
}

function defaultMode(filePath: string | null, initialMode?: FileViewMode): FileViewMode {
  if (initialMode) return initialMode
  const filename = filePath?.split('/').pop() ?? ''
  return isHtmlFile(filename) ? 'rendered' : 'page'
}

/**
 * View-mode state for a file surface (file tab or preview panel). Markdown
 * opens as a page, HTML as a rendered live page (unless `initialMode` pins it,
 * e.g. an agent opening a file explicitly in source). Resets whenever the
 * underlying file changes.
 */
export function useFileViewMode(
  filePath: string | null,
  initialMode?: FileViewMode
): UseFileViewMode {
  const [viewMode, setViewMode] = useState<FileViewMode>(defaultMode(filePath, initialMode))

  // Reset to the file kind's default whenever the file changes (derive, no effect)
  const [prevFilePath, setPrevFilePath] = useState(filePath)
  if (filePath !== prevFilePath) {
    setPrevFilePath(filePath)
    setViewMode(defaultMode(filePath, initialMode))
  }

  // A changed pin (e.g. an agent re-opening the same tab in another mode) retargets it
  const [prevInitialMode, setPrevInitialMode] = useState(initialMode)
  if (initialMode !== prevInitialMode) {
    setPrevInitialMode(initialMode)
    if (initialMode) setViewMode(initialMode)
  }

  const filename = filePath?.split('/').pop() ?? ''
  return {
    isMarkdown: !!filePath && isMarkdownFile(filename),
    isHtml: !!filePath && isHtmlFile(filename),
    viewMode,
    setViewMode
  }
}
