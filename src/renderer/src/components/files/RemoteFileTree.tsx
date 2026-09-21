import { useEffect, useCallback } from 'react'
import { useRemoteFileTree, type FlatRemoteTreeNode } from '../../hooks/use-remote-file-tree'
import { useSessionStore } from '../../store/session-store'
import { FileIcon } from './file-icons'
import { ArrowPathIcon } from '@heroicons/react/24/outline'

interface RemoteFileTreeProps {
  locationId: string
  cwd: string
}

export function RemoteFileTree({ locationId, cwd }: RemoteFileTreeProps) {
  const { flatNodes, loaded, error, loadRoot, refresh, toggleExpand } = useRemoteFileTree(locationId, cwd)
  const setPreviewFile = useSessionStore((s) => s.setPreviewFile)

  useEffect(() => {
    if (!loaded) loadRoot()
  }, [loaded, loadRoot])

  const handleFileClick = useCallback(
    async (node: FlatRemoteTreeNode) => {
      if (node.type === 'directory') {
        toggleExpand(node.path)
        return
      }
      // Store in preview — reuse existing preview system
      setPreviewFile(node.path, 'tree', cwd, locationId)
    },
    [locationId, cwd, toggleExpand, setPreviewFile]
  )

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center px-3">
        <span className="text-xs text-red-400 text-center">{error}</span>
      </div>
    )
  }

  if (!loaded) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-xs text-text-tertiary">Loading...</span>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Refresh header */}
      <div className="flex items-center justify-end px-2 py-1 flex-shrink-0">
        <button
          onClick={refresh}
          className="btn-icon btn-icon-sm"
          title="Refresh"
        >
          <ArrowPathIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tree content */}
      <div className="flex-1 overflow-y-auto px-1">
        {flatNodes.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-text-tertiary">
            Empty directory
          </div>
        ) : (
          flatNodes.map((node) => (
            <RemoteFileTreeRow
              key={node.path}
              node={node}
              onClick={handleFileClick}
            />
          ))
        )}
      </div>
    </div>
  )
}

function RemoteFileTreeRow({
  node,
  onClick
}: {
  node: FlatRemoteTreeNode
  onClick: (node: FlatRemoteTreeNode) => void
}) {
  return (
    <button
      onClick={() => onClick(node)}
      className="w-full flex items-center h-control-md px-2 cursor-pointer select-none transition-colors text-sm text-left hover:bg-surface-100"
      style={{ paddingLeft: `${8 + node.depth * 8}px` }}
      title={node.name}
    >
      {/* Chevron for directories */}
      {node.type === 'directory' ? (
        <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-[color:var(--tree-chevron-color)]">
          {node.loading ? (
            <svg width="12" height="12" viewBox="0 0 12 12" className="animate-spin">
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeDasharray="20" strokeDashoffset="10" />
            </svg>
          ) : (
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              className={`transition-transform duration-100 ${node.expanded ? 'rotate-90' : ''}`}
            >
              <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      ) : (
        <span className="w-4 flex-shrink-0" />
      )}

      <FileIcon
        name={node.name}
        isDirectory={node.type === 'directory'}
        isOpen={node.expanded}
        className="flex-shrink-0 text-[color:var(--sidebar-icon-color)] ml-0.5 mr-1.5"
      />

      <span className="truncate text-xs font-medium text-[color:var(--sidebar-item-text)]">
        {node.name}
      </span>
    </button>
  )
}
