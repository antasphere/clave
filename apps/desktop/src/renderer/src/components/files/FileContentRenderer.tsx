import { FileContent } from './FileContent'
import { useFileEditor } from '../../hooks/use-file-editor'
import { formatSize, type FileViewMode } from './file-types'

interface FileContentRendererProps {
  editor: ReturnType<typeof useFileEditor>
  filePath: string | null
  cwd: string | null
  viewMode?: FileViewMode
  /** Bumped by the header's Reload button; reloads a rendered .html page. */
  reloadKey?: number
  className?: string
}

export function FileContentRenderer({
  editor,
  filePath,
  cwd,
  viewMode,
  reloadKey,
  className
}: FileContentRendererProps): React.JSX.Element | null {
  const { fileData, saveError } = editor

  if (!filePath) return null

  return (
    <div className={`flex flex-col min-h-0 ${className ?? ''}`}>
      {/* Content */}
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        <FileContent
          editor={editor}
          cwd={cwd}
          filePath={filePath}
          viewMode={viewMode}
          reloadKey={reloadKey}
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
    </div>
  )
}
