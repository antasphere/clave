import { useCallback, useRef } from 'react'
import { FileIcon } from './file-icons'
import { TREE_INDENT_PX, TREE_ROW_PAD_PX } from './tree-metrics'
import type { FlatTreeNode } from '../../hooks/use-file-tree'

const DOUBLE_CLICK_MS = 300

interface FileTreeItemProps {
  node: FlatTreeNode
  isSelected: boolean
  onClickFile: (path: string) => void
  onSelect: (path: string, metaKey: boolean) => void
  onDoubleClickFile: (path: string) => void
  onDoubleClickDir: (path: string) => void
  onToggleDir: (path: string) => void
  onContextMenu: (e: React.MouseEvent, node: FlatTreeNode) => void
  onDragStart: (e: React.DragEvent, node: FlatTreeNode) => void
}

export function FileTreeItem({
  node,
  isSelected,
  onClickFile,
  onSelect,
  onDoubleClickFile,
  onDoubleClickDir,
  onToggleDir,
  onContextMenu,
  onDragStart
}: FileTreeItemProps): React.JSX.Element {
  const lastClickRef = useRef<{ time: number; path: string }>({ time: 0, path: '' })

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const now = Date.now()
      const last = lastClickRef.current
      if (last.path === node.path && now - last.time < DOUBLE_CLICK_MS) {
        lastClickRef.current = { time: 0, path: '' }
        if (node.type === 'file') {
          onDoubleClickFile(node.path)
        } else {
          onDoubleClickDir(node.path)
        }
        return
      }
      lastClickRef.current = { time: now, path: node.path }
      // Cmd+click: toggle selection (works for both files and directories)
      if (e.metaKey) {
        onSelect(node.path, true)
        return
      }
      // Regular click
      if (node.type === 'directory') {
        onToggleDir(node.path)
      } else {
        onClickFile(node.path)
      }
      onSelect(node.path, false) // clear selection on regular click
    },
    [node, onClickFile, onSelect, onToggleDir, onDoubleClickFile, onDoubleClickDir]
  )

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      onDragStart(e, node)
    },
    [node, onDragStart]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      onContextMenu(e, node)
    },
    [node, onContextMenu]
  )

  return (
    <div
      data-tree-item
      data-tree-depth={node.depth}
      data-tree-name={node.name}
      data-tree-expanded={node.type === 'directory' ? String(!!node.expanded) : undefined}
      className={`flex items-center gap-1.5 h-[var(--panel-row-h)] pr-3 cursor-pointer select-none transition-colors text-sm ${
        isSelected ? 'bg-surface-200' : 'hover:bg-surface-100'
      } ${node.ignored ? 'opacity-40' : ''}`}
      style={{ paddingLeft: `${TREE_ROW_PAD_PX + node.depth * TREE_INDENT_PX}px` }}
      title={node.name}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      draggable
      onDragStart={handleDragStart}
    >
      {/* Chevron for directories — a bare glyph on the row's gap, the way the
          git tree's rows carry theirs. A file holds the same column open with
          a spacer so the names line up. */}
      {node.type === 'directory' ? (
        node.loading ? (
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            className="flex-shrink-0 animate-spin text-[color:var(--tree-chevron-color)]"
          >
            <circle
              cx="6"
              cy="6"
              r="5"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeDasharray="20"
              strokeDashoffset="10"
            />
          </svg>
        ) : (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            className={`flex-shrink-0 text-[color:var(--tree-chevron-color)] transition-transform duration-100 ${node.expanded ? 'rotate-90' : ''}`}
          >
            <path
              d="M3 1.5L7 5L3 8.5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )
      ) : (
        <span className="w-2.5 flex-shrink-0" />
      )}

      <FileIcon
        name={node.name}
        isDirectory={node.type === 'directory'}
        isOpen={node.expanded}
        className="flex-shrink-0 text-[color:var(--sidebar-icon-color)]"
      />

      <span className="truncate text-xs font-medium">
        <span className="text-[color:var(--sidebar-item-text)]">{node.name}</span>
        {node.type === 'file' && node.path.includes('/') && node.depth === 0 && (
          <span className="text-text-tertiary ml-1.5">
            {node.path.slice(0, node.path.lastIndexOf('/'))}
          </span>
        )}
      </span>
    </div>
  )
}
