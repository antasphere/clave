import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  FolderIcon,
  ChevronRightIcon,
  HomeIcon,
  ArrowUpIcon,
  XMarkIcon,
  PencilSquareIcon,
  CheckIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline'
import { cn } from '@clave/ui/components'

interface RemoteDirectoryPickerProps {
  locationId: string
  locationName: string
  onSelect: (path: string) => void
  onCancel: () => void
}

interface DirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
}

interface NavItem {
  kind: 'up' | 'dir'
  name: string
  path: string
}

function parentOf(path: string): string {
  return path.split('/').slice(0, -1).join('/') || '/'
}

export function RemoteDirectoryPicker({
  locationId,
  locationName,
  onSelect,
  onCancel
}: RemoteDirectoryPickerProps) {
  const [currentPath, setCurrentPath] = useState('')
  const [homePath, setHomePath] = useState('')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [editingPath, setEditingPath] = useState(false)
  const [highlight, setHighlight] = useState(-1)

  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const highlightedRowRef = useRef<HTMLButtonElement>(null)
  const editingRef = useRef(editingPath)
  editingRef.current = editingPath

  // Resolve home directory on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await window.electronAPI.sshExec(locationId, 'echo $HOME')
        const home = result.stdout.trim() || '/home'
        if (!cancelled) {
          setHomePath(home)
          setCurrentPath(home)
          setPathInput(home)
        }
      } catch {
        if (!cancelled) {
          setHomePath('/home')
          setCurrentPath('/home')
          setPathInput('/home')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [locationId])

  // Load directory contents when path changes
  useEffect(() => {
    if (!currentPath) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setHighlight(-1)
    ;(async () => {
      try {
        const items = await window.electronAPI.sftpReadDir(locationId, currentPath)
        if (!cancelled) {
          setEntries(
            (items as DirEntry[])
              .filter((e) => e.type === 'directory')
              .sort((a, b) => a.name.localeCompare(b.name))
          )
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to read directory')
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [locationId, currentPath])

  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path)
    setPathInput(path)
    setEditingPath(false)
  }, [])

  const commitPathInput = useCallback(() => {
    const trimmed = pathInput.trim()
    if (trimmed) setCurrentPath(trimmed)
    setEditingPath(false)
  }, [pathInput])

  const startEditing = useCallback(() => {
    setPathInput(currentPath)
    setEditingPath(true)
  }, [currentPath])

  // Focus the address input in edit mode; otherwise keep focus on the card so
  // arrow-key navigation works (also handles initial mount).
  useEffect(() => {
    if (editingPath) {
      inputRef.current?.focus()
      inputRef.current?.select()
    } else {
      cardRef.current?.focus()
    }
  }, [editingPath])

  // Breadcrumb segments
  const breadcrumbs = useMemo(() => {
    const parts = currentPath.split('/').filter(Boolean)
    return parts.map((part, i) => ({
      name: part,
      path: '/' + parts.slice(0, i + 1).join('/')
    }))
  }, [currentPath])

  const showUp = currentPath !== '/' && currentPath !== ''

  const navItems = useMemo<NavItem[]>(() => {
    const items: NavItem[] = []
    if (showUp) items.push({ kind: 'up', name: '..', path: parentOf(currentPath) })
    for (const e of entries) items.push({ kind: 'dir', name: e.name, path: e.path })
    return items
  }, [entries, showUp, currentPath])

  // Keep the highlighted row scrolled into view
  useEffect(() => {
    highlightedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  // Global Escape: exit edit mode first, otherwise close the picker
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (editingRef.current) {
        setEditingPath(false)
      } else {
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const handleCardKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editingPath) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((i) => Math.min(i + 1, navItems.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (highlight >= 0 && navItems[highlight]) {
          navigateTo(navItems[highlight].path)
        } else if (currentPath) {
          onSelect(currentPath)
        }
      }
    },
    [editingPath, navItems, highlight, currentPath, navigateTo, onSelect]
  )

  return createPortal(
    <div
      className="modal-scrim scrim-mount z-50 flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        onKeyDown={handleCardKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="modal-card menu-pop-mount w-[520px] max-h-[560px] flex flex-col outline-none"
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border-subtle">
          <FolderIcon className="w-4 h-4 text-accent flex-shrink-0" />
          <h3 className="flex-1 min-w-0 text-[13px] font-semibold text-text-primary">
            Open folder
          </h3>
          <span
            className="badge bg-surface-100 text-text-tertiary max-w-[140px] truncate"
            title={locationName}
          >
            {locationName}
          </span>
          <button onClick={onCancel} className="btn-icon btn-icon-sm flex-shrink-0">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar: up / home + breadcrumb or editable address bar */}
        <div className="flex items-center gap-1 px-2.5 py-2 border-b border-border-subtle">
          <button
            onClick={() => navigateTo(parentOf(currentPath))}
            disabled={!showUp}
            title="Up one level"
            className="btn-icon btn-icon-sm flex-shrink-0 disabled:opacity-30 disabled:pointer-events-none"
          >
            <ArrowUpIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => navigateTo(homePath)}
            disabled={!homePath}
            title="Home directory"
            className="btn-icon btn-icon-sm flex-shrink-0 disabled:opacity-30 disabled:pointer-events-none"
          >
            <HomeIcon className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-border-subtle mx-1 flex-shrink-0" />

          {editingPath ? (
            <input
              ref={inputRef}
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitPathInput()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setEditingPath(false)
                }
              }}
              onBlur={commitPathInput}
              placeholder="/path/to/directory"
              className="input-compact flex-1 min-w-0 font-mono"
            />
          ) : (
            <button
              onClick={startEditing}
              title="Edit path"
              className="flex-1 min-w-0 flex items-center gap-0.5 h-7 px-1.5 rounded-lg text-xs text-text-tertiary overflow-x-auto hover:bg-surface-100 transition-colors"
            >
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  navigateTo('/')
                }}
                className="flex-shrink-0 px-1 rounded hover:text-text-primary transition-colors"
              >
                /
              </span>
              {breadcrumbs.map((crumb, i) => (
                <span key={crumb.path} className="flex items-center gap-0.5 flex-shrink-0">
                  <ChevronRightIcon className="w-3 h-3 opacity-60" />
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      navigateTo(crumb.path)
                    }}
                    className={cn(
                      'px-1 rounded hover:text-text-primary transition-colors',
                      i === breadcrumbs.length - 1 && 'text-text-primary font-medium'
                    )}
                  >
                    {crumb.name}
                  </span>
                </span>
              ))}
            </button>
          )}

          <button
            onClick={editingPath ? commitPathInput : startEditing}
            title={editingPath ? 'Go' : 'Edit path'}
            className="btn-icon btn-icon-sm flex-shrink-0"
          >
            {editingPath ? <CheckIcon className="w-4 h-4" /> : <PencilSquareIcon className="w-4 h-4" />}
          </button>
        </div>

        {/* Directory listing */}
        <div className="flex-1 overflow-y-auto min-h-0 p-1.5">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
              <ArrowPathIcon className="w-5 h-5 animate-spin" />
              <span className="text-xs">Loading…</span>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-12 px-4 text-center">
              <span className="text-xs text-red-400">{error}</span>
            </div>
          ) : navItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
              <FolderIcon className="w-6 h-6 opacity-50" />
              <span className="text-xs">No subfolders here</span>
            </div>
          ) : (
            navItems.map((item, i) => (
              <button
                key={item.kind === 'up' ? '..' : item.path}
                ref={i === highlight ? highlightedRowRef : undefined}
                onClick={() => navigateTo(item.path)}
                onMouseMove={() => setHighlight(i)}
                className={cn(
                  'group w-full flex items-center gap-2.5 px-2.5 h-8 rounded-lg text-left transition-colors',
                  i === highlight ? 'bg-surface-100' : 'hover:bg-surface-100'
                )}
              >
                <FolderIcon
                  className={cn(
                    'w-4 h-4 flex-shrink-0 transition-colors',
                    item.kind === 'up'
                      ? 'text-text-tertiary'
                      : 'text-text-tertiary group-hover:text-accent'
                  )}
                />
                <span
                  className={cn(
                    'flex-1 min-w-0 truncate text-[13px]',
                    item.kind === 'up' ? 'text-text-secondary' : 'text-text-primary'
                  )}
                >
                  {item.name}
                </span>
                <ChevronRightIcon className="w-3.5 h-3.5 text-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-4 py-3 border-t border-border-subtle bg-surface-100/30">
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-text-tertiary font-semibold flex-shrink-0">
              Open in
            </span>
            <span
              className="text-[11px] text-text-secondary font-mono truncate"
              title={currentPath}
            >
              {currentPath || '—'}
            </span>
          </div>
          <button onClick={onCancel} className="btn-secondary flex-shrink-0">
            Cancel
          </button>
          <button
            onClick={() => onSelect(currentPath)}
            disabled={!currentPath}
            className="btn-primary flex-shrink-0"
          >
            Open
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
