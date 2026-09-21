import { useState, useCallback, useRef, useEffect } from 'react'
import { useSessionStore } from '../../store/session-store'
import { openSessionProgrammatically } from '../../lib/mcp-dispatcher'
import { useFileTree, type FlatTreeNode } from '../../hooks/use-file-tree'
import { FileTreeItem } from './FileTreeItem'
import { TREE_INDENT_PX, TREE_ROW_PAD_PX } from './tree-metrics'
import { ContextMenu } from '../ui/ContextMenu'
import {
  EyeIcon,
  WindowIcon,
  PencilSquareIcon,
  ArrowTopRightOnSquareIcon,
  FolderOpenIcon,
  MapIcon,
  DocumentPlusIcon,
  FolderPlusIcon,
  DocumentDuplicateIcon,
  ClipboardDocumentIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'

interface ContextMenuState {
  x: number
  y: number
  items: { label: string; onClick: () => void; shortcut?: string; icon?: React.ReactNode }[]
}

interface InlineCreateState {
  parentPath: string // '.' for root
  type: 'file' | 'directory'
}

function InlineCreateInput({
  state,
  cwd,
  depth,
  onCreated,
  onCancel
}: {
  state: InlineCreateState
  cwd: string
  depth: number
  onCreated: (path: string, type: 'file' | 'directory') => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    const name = value.trim()
    if (!name) {
      onCancel()
      return
    }

    // Basic validation
    if (name.includes('/') || name.includes('\\')) {
      setError('Invalid name')
      return
    }

    const relativePath = state.parentPath === '.' ? name : `${state.parentPath}/${name}`

    try {
      if (state.type === 'file') {
        await window.electronAPI?.createFile(cwd, relativePath)
      } else {
        await window.electronAPI?.createDirectory(cwd, relativePath)
      }
      onCreated(relativePath, state.type)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create')
    }
  }, [value, state, cwd, onCreated, onCancel])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    },
    [submit, onCancel]
  )

  return (
    <div
      className="flex items-center gap-1.5 h-control-md pr-3"
      style={{ paddingLeft: `${TREE_ROW_PAD_PX + depth * TREE_INDENT_PX}px` }}
    >
      <span className="w-2.5 flex-shrink-0" />
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        className="flex-shrink-0 text-text-tertiary"
      >
        {state.type === 'file' ? (
          <path
            d="M3 1.5H8.5L11 4V12.5H3V1.5Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M1.5 3.5C1.5 2.95 1.95 2.5 2.5 2.5H5L6.5 4H11.5C12.05 4 12.5 4.45 12.5 5V10.5C12.5 11.05 12.05 11.5 11.5 11.5H2.5C1.95 11.5 1.5 11.05 1.5 10.5V3.5Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        )}
      </svg>
      <div className="flex-1 min-w-0 flex flex-col">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          onKeyDown={handleKeyDown}
          onBlur={submit}
          placeholder={state.type === 'file' ? 'filename' : 'folder name'}
          className={`w-full h-control-xs px-1.5 rounded text-xs font-mono bg-surface-100 text-text-primary placeholder:text-text-tertiary outline-none border ${
            error ? 'border-red-400' : 'border-accent'
          }`}
        />
        {error && (
          <span className="text-[10px] text-red-400 mt-0.5">{error}</span>
        )}
      </div>
    </div>
  )
}

/**
 * The hairline between two rows of the file tree. The git tab's tree is ruled
 * the same way and for the same reason (see `TreeRule` in GitStatusPanel): the
 * two tabs are one panel with two views, so a boundary has to look the same in
 * both.
 *
 * Every row takes one but the first — a folder and the first thing inside it
 * included. That pairing used to be exempt on the theory that a line there cuts
 * a folder off from its own contents; in the panel it read as the one place the
 * ruling gave out, so the exemption is gone from both trees.
 *
 * Drawn at the depth of the row BELOW it, so it lines up with what it
 * introduces rather than with whatever the row above happened to be: a
 * full-bleed line cuts across the indentation and costs the reader the sense of
 * the tree.
 */
function TreeRule({ depth }: { depth: number }): React.JSX.Element {
  return (
    <div
      className="tree-rule"
      data-file-tree-rule={depth}
      style={{ marginLeft: TREE_ROW_PAD_PX + depth * TREE_INDENT_PX, marginRight: 12 }}
    />
  )
}

export function FileTree({ cwd, onNavigateToFolder }: {
  cwd: string | null
  onNavigateToFolder: (absolutePath: string) => void
}) {
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId)
  const setPreviewFile = useSessionStore((s) => s.setPreviewFile)
  const addFileTab = useSessionStore((s) => s.addFileTab)

  const { flatList, loading, filter, setFilter, toggleDir, refreshDir, collapseAll } = useFileTree(cwd)

  /**
   * Only a NEW collapse-all press folds anything.
   *
   * `collapseAllTrigger` is a monotonic counter that never resets within a run,
   * so a bare `> 0` test also fires on MOUNT — and this panel really does
   * unmount, since AppShell renders it behind `fileTreeOpen`. After one press
   * anywhere, every reopen of the panel re-ran collapse-all.
   *
   * That was survivable while `collapseAll` cleared a cache private to this
   * tree. It is not now: it clears the set BOTH tabs read, so a panel toggle
   * silently threw away the folders the user had open in either of them.
   * Initialising the previous value at mount is what distinguishes a real
   * press from the stale count — the same guard the git tab's directory rows
   * use, and the shape of PRDCT-1672.
   */
  const collapseAllTrigger = useSessionStore((s) => s.collapseAllTrigger)
  const [prevCollapseAll, setPrevCollapseAll] = useState(collapseAllTrigger)
  if (prevCollapseAll !== collapseAllTrigger) {
    setPrevCollapseAll(collapseAllTrigger)
    collapseAll()
  }

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [inlineCreate, setInlineCreate] = useState<InlineCreateState | null>(null)

  const handleClickFile = useCallback(
    (_filePath: string) => {
      // Plain click on file — no-op here, selection handled by handleSelect
    },
    []
  )

  const handleSelect = useCallback(
    (path: string, metaKey: boolean) => {
      if (!focusedSessionId || !cwd) return
      if (metaKey) {
        setSelectedPaths((prev) => {
          const next = new Set(prev)
          if (next.has(path)) {
            next.delete(path)
          } else {
            next.add(path)
          }
          return next
        })
      } else {
        setSelectedPaths(new Set())
      }
    },
    [focusedSessionId, cwd]
  )

  const handleDoubleClickFile = useCallback(
    (filePath: string) => {
      setPreviewFile(filePath, 'tree', cwd)
    },
    [setPreviewFile, cwd]
  )

  const handleDoubleClickDir = useCallback(
    (_dirPath: string) => {
      // Navigation on double-click removed — use "Open as Root" from context menu instead
    },
    []
  )

  const handleDragStart = useCallback(
    (e: React.DragEvent, node: FlatTreeNode) => {
      if (!cwd) return
      if (selectedPaths.size > 1 && selectedPaths.has(node.path)) {
        const paths = Array.from(selectedPaths)
          .map((p) => `${cwd}/${p}`)
          .join('\n')
        e.dataTransfer.setData('text/plain', paths)
      } else {
        e.dataTransfer.setData('text/plain', `${cwd}/${node.path}`)
      }
      e.dataTransfer.effectAllowed = 'copy'
    },
    [cwd, selectedPaths]
  )

  const handleInlineCreated = useCallback(
    async (relativePath: string, type: 'file' | 'directory') => {
      if (!cwd || !inlineCreate) return
      const parentPath = inlineCreate.parentPath
      setInlineCreate(null)
      // Refresh the parent directory in the tree
      await refreshDir(parentPath)
      // A new file opens BIG, as a tab, and not in the side sheet: a document
      // you just named is a document you are about to write, and the 560px
      // preview column gave a brand-new empty file a 28px editable strip you
      // had to find and click before a single keystroke landed anywhere.
      if (type === 'file') {
        const filename = relativePath.split('/').pop() ?? relativePath
        addFileTab({
          id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          filePath: `${cwd}/${relativePath}`,
          name: filename
        })
      }
    },
    [cwd, inlineCreate, refreshDir, addFileTab]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: FlatTreeNode) => {
      if (!cwd) return
      const absPath = `${cwd}/${node.path}`
      const items: ContextMenuState['items'] = []

      if (node.type === 'file') {
        items.push({
          label: 'Preview',
          icon: <EyeIcon className="w-3.5 h-3.5" />,
          onClick: () => setPreviewFile(node.path, 'tree', cwd)
        })
        items.push({
          label: 'Open in Tab',
          icon: <WindowIcon className="w-3.5 h-3.5" />,
          onClick: () => {
            const filename = node.path.split('/').pop() ?? node.path
            addFileTab({
              id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              filePath: `${cwd}/${node.path}`,
              name: filename
            })
          }
        })
        items.push({
          label: 'Edit',
          icon: <PencilSquareIcon className="w-3.5 h-3.5" />,
          onClick: () => setPreviewFile(node.path, 'tree', cwd)
        })
        const fileExt = node.path.split('.').pop()?.toLowerCase() ?? ''
        const externalExts = new Set(['html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])
        if (externalExts.has(fileExt)) {
          items.push({
            label: 'Open Externally',
            icon: <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />,
            onClick: () => { window.electronAPI?.openPath(absPath) }
          })
        }
      }
      if (node.type === 'directory') {
        items.push({
          label: 'Open as Root',
          icon: <FolderOpenIcon className="w-3.5 h-3.5" />,
          onClick: () => onNavigateToFolder(absPath)
        })
        // A Slideless deck directly contains slideless.json. Synchronous check so
        // the menu opens instantly with the right item (no async flicker).
        if (window.electronAPI?.existsSync(cwd, `${node.path}/slideless.json`)) {
          items.push({
            label: 'Run Slideless',
            icon: <PlayIcon className="w-3.5 h-3.5" />,
            onClick: () => {
              const folderName = node.path.split('/').pop() ?? node.path
              openSessionProgrammatically({
                cwd: absPath,
                mode: 'terminal',
                command: 'slideless dev .',
                autoRun: true,
                name: `slideless · ${folderName}`
              })
            }
          })
        }
        items.push({
          label: 'Journey',
          icon: <MapIcon className="w-3.5 h-3.5" />,
          onClick: () => {
            const folderName = node.path.split('/').pop() ?? node.path
            useSessionStore.getState().openJourneyPanel(absPath, folderName)
          }
        })
        items.push({
          label: 'New File...',
          icon: <DocumentPlusIcon className="w-3.5 h-3.5" />,
          onClick: () => setInlineCreate({ parentPath: node.path, type: 'file' })
        })
        items.push({
          label: 'New Folder...',
          icon: <FolderPlusIcon className="w-3.5 h-3.5" />,
          onClick: () => setInlineCreate({ parentPath: node.path, type: 'directory' })
        })
      }
      items.push({
        label: 'Copy Relative Path',
        icon: <DocumentDuplicateIcon className="w-3.5 h-3.5" />,
        onClick: () => navigator.clipboard.writeText(`./${node.path}`)
      })
      items.push({
        label: 'Copy Absolute Path',
        icon: <ClipboardDocumentIcon className="w-3.5 h-3.5" />,
        onClick: () => navigator.clipboard.writeText(absPath)
      })
      items.push({
        label: 'Reveal in Finder',
        icon: <MagnifyingGlassIcon className="w-3.5 h-3.5" />,
        onClick: () => { window.electronAPI?.showItemInFolder(absPath) }
      })
      setContextMenu({ x: e.clientX, y: e.clientY, items })
    },
    [cwd, setPreviewFile, onNavigateToFolder]
  )

  // Context menu on empty area — allow creating at root
  const handleEmptyContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!cwd) return
      // Only if right-clicking the empty space (not on an item)
      if ((e.target as HTMLElement).closest('[data-tree-item]')) return
      e.preventDefault()
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'New File...',
            icon: <DocumentPlusIcon className="w-3.5 h-3.5" />,
            onClick: () => setInlineCreate({ parentPath: '.', type: 'file' })
          },
          {
            label: 'New Folder...',
            icon: <FolderPlusIcon className="w-3.5 h-3.5" />,
            onClick: () => setInlineCreate({ parentPath: '.', type: 'directory' })
          }
        ]
      })
    },
    [cwd]
  )

  // Build flat list with inline create input inserted at the right position
  const renderList = useCallback(() => {
    const elements: React.ReactNode[] = []

    for (let i = 0; i < flatList.length; i++) {
      const node = flatList[i]
      // Every row but the first is ruled off from the one above it, at its own
      // depth — files included, and a folder's first child included. The git
      // tab's tree rules the same way; the two used to hold back at exactly the
      // boundaries a reader looks for (a folder and its first child, one file
      // and the next), which showed as ruling that gives out halfway down.
      // The first row closes nothing, so it takes none.
      if (i > 0) {
        elements.push(<TreeRule key={`rule:${node.path}`} depth={node.depth} />)
      }
      elements.push(
        <FileTreeItem
          key={node.path}
          node={node}
          isSelected={selectedPaths.has(node.path)}
          onClickFile={handleClickFile}
          onSelect={handleSelect}
          onDoubleClickFile={handleDoubleClickFile}
          onDoubleClickDir={handleDoubleClickDir}
          onToggleDir={toggleDir}
          onContextMenu={handleContextMenu}
          onDragStart={handleDragStart}
        />
      )

      // If this is the directory where we're creating, insert inline input after it
      if (inlineCreate && node.type === 'directory' && node.path === inlineCreate.parentPath && node.expanded) {
        elements.push(
          <InlineCreateInput
            key="__inline-create__"
            state={inlineCreate}
            cwd={cwd!}
            depth={node.depth + 1}
            onCreated={handleInlineCreated}
            onCancel={() => setInlineCreate(null)}
          />
        )
      }
    }

    // Inline create at root level
    if (inlineCreate && inlineCreate.parentPath === '.') {
      elements.unshift(
        <InlineCreateInput
          key="__inline-create__"
          state={inlineCreate}
          cwd={cwd!}
          depth={0}
          onCreated={handleInlineCreated}
          onCancel={() => setInlineCreate(null)}
        />
      )
    }

    return elements
  }, [flatList, inlineCreate, cwd, selectedPaths, handleClickFile, handleSelect, handleDoubleClickFile, handleDoubleClickDir, toggleDir, handleContextMenu, handleDragStart, handleInlineCreated])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* The tab's own bar — the same field the sidebar searches groups with,
          so "narrow a list" looks the same on both edges of the window. The
          folder picker, the way home and collapse-all are NOT here: they belong
          to both tabs and live in the panel's tab bar above. */}
      <div className="px-2 pb-1.5 flex-shrink-0">
        {/* A field, not a bar around a field. A frame groups two or more
            controls; this row has one, and framed alone it was a 28px field
            inside a 34px box, the thickest-looking thing on the panel
            (2026-09-21). The wrapper keeps the bar's name for the specs. */}
        <div data-panel-bar="files">
          <div className="search-field">
            <MagnifyingGlassIcon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && filter) {
                  e.stopPropagation()
                  setFilter('')
                }
              }}
              placeholder="Filter files"
              aria-label="Filter files"
              spellCheck={false}
            />
            {filter && (
              <button
                className="search-field-clear"
                onClick={() => setFilter('')}
                title="Clear filter"
                aria-label="Clear filter"
              >
                <XMarkIcon className="w-3 h-3" />
              </button>
  )}
          </div>
        </div>
      </div>

      {/* Tree list */}
      <div
        className="flex-1 overflow-y-auto"
        onContextMenu={handleEmptyContextMenu}
      >
        {!cwd ? (
          <div className="px-3 py-8 text-center text-xs text-text-tertiary">
            Open a workspace or focus a session to browse files
          </div>
        ) : loading ? (
          <div className="px-3 py-8 text-center text-xs text-text-tertiary">Loading...</div>
        ) : flatList.length === 0 && !inlineCreate ? (
          <div className="px-3 py-8 text-center text-xs text-text-tertiary">
            {filter ? 'No matching files' : 'Empty directory'}
          </div>
        ) : (
          renderList()
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
