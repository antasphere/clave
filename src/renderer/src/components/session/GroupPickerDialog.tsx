import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  usePinnedStore,
  spawnTemplate,
  importClaveFile,
  type PinnedGroup
} from '../../store/pinned-store'
import { resolveColorHex } from '../../store/session-types'
import { inActiveWorkspace } from '../../store/session-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { cn } from '@clave/ui/components'
import {
  MagnifyingGlassIcon,
  DocumentIcon,
  XMarkIcon,
  ChatBubbleLeftEllipsisIcon,
  CommandLineIcon,
  Squares2X2Icon
} from '@heroicons/react/24/outline'

interface GroupPickerDialogProps {
  onClose: () => void
  onContextMenu: (e: React.MouseEvent, pinnedId: string) => void
}

/**
 * The full-screen group picker: every group you can add, as cards, with search.
 *
 * It replaces the narrow template popover that used to sit behind the Sessions
 * header icon — same data and same act (a group is a stamp: clicking it spawns a
 * fresh group and never links back to a live one), given the room to be scanned
 * rather than scrolled. Reachable from the `+` beside the Sessions heading and
 * from that same header icon.
 */
export function GroupPickerDialog({
  onClose,
  onContextMenu
}: GroupPickerDialogProps): React.ReactPortal {
  const allPinnedGroups = usePinnedStore((s) => s.pinnedGroups)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const [query, setQuery] = useState('')
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  const [flashPinnedId, setFlashPinnedId] = useState<string | null>(null)

  const templates = useMemo(
    () => allPinnedGroups.filter((pg) => !pg.toolbar && inActiveWorkspace(pg, activeWorkspaceId)),
    [allPinnedGroups, activeWorkspaceId]
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Filter by name and category, then section by category (uncategorized first,
  // categories alphabetical) — the same order the popover used, so a workspace
  // that was authored against it still reads the way its author expected.
  const categorized = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? templates.filter(
          (t) => t.name.toLowerCase().includes(q) || (t.category ?? '').toLowerCase().includes(q)
        )
      : templates
    const categoryMap = new Map<string, PinnedGroup[]>()
    const uncategorized: PinnedGroup[] = []
    for (const pg of filtered) {
      if (pg.category) {
        const existing = categoryMap.get(pg.category)
        if (existing) existing.push(pg)
        else categoryMap.set(pg.category, [pg])
      } else {
        uncategorized.push(pg)
      }
    }
    const sorted = [...categoryMap.entries()].sort(([a], [b]) => a.localeCompare(b))
    const result: { category: string | null; groups: PinnedGroup[] }[] = []
    if (uncategorized.length > 0) result.push({ category: null, groups: uncategorized })
    for (const [cat, groups] of sorted) result.push({ category: cat, groups })
    return result
  }, [templates, query])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsFileDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsFileDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsFileDragOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const filePath = window.electronAPI?.getPathForFile(file)
    if (!filePath || !filePath.endsWith('.clave')) return
    // Dropping a .clave only ADDS it to the list — it doesn't launch. An
    // explicit drop is an explicit act: the pin joins the ACTIVE workspace even
    // when the file lives outside its root.
    const result = await importClaveFile(filePath, {
      autoLaunch: false,
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId
    })
    if (result?.alreadyExists) {
      setFlashPinnedId(result.pinnedId)
      setTimeout(() => setFlashPinnedId(null), 1500)
    }
  }, [])

  const pick = useCallback(
    (pinnedId: string) => {
      void spawnTemplate(pinnedId)
      onClose()
    },
    [onClose]
  )

  return createPortal(
    <div
      className="group-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Add a group"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="group-picker-panel"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
          <Squares2X2Icon className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
          <h2 className="text-control font-medium text-text-primary">Add a group</h2>
          <div className="search-field ml-2">
            <MagnifyingGlassIcon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search groups…"
              aria-label="Search groups"
              spellCheck={false}
            />
            {query && (
              <button
                className="search-field-clear"
                onClick={() => setQuery('')}
                title="Clear search"
                aria-label="Clear search"
              >
                <XMarkIcon className="w-3 h-3" />
              </button>
            )}
          </div>
          <button className="panel-icon-btn" onClick={onClose} aria-label="Close">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {templates.length === 0 ? (
            <p className="py-10 text-center text-xs text-text-tertiary">
              No groups yet. Drag a group here, or drop a{' '}
              <code className="text-text-secondary">.clave</code> file.
            </p>
          ) : categorized.length === 0 ? (
            <p className="py-10 text-center text-xs text-text-tertiary">No matching groups</p>
          ) : (
            categorized.map(({ category, groups }) => (
              <div key={category ?? '__uncategorized'} className="space-y-2">
                {category && (
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary/60 select-none">
                    {category}
                  </div>
                )}
                <div className="group-picker-grid">
                  {groups.map((pg) => (
                    <GroupCard
                      key={pg.id}
                      template={pg}
                      flashing={pg.id === flashPinnedId}
                      onPick={pick}
                      onContextMenu={onContextMenu}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-1.5 px-4 py-2.5 border-t border-border-subtle text-[11px] text-text-tertiary/70">
          <DocumentIcon className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">
            {isFileDragOver ? 'Drop to add' : 'Drop a .clave file to add a group'}
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}

function GroupCard({
  template,
  flashing,
  onPick,
  onContextMenu
}: {
  template: PinnedGroup
  flashing: boolean
  onPick: (pinnedId: string) => void
  onContextMenu: (e: React.MouseEvent, pinnedId: string) => void
}): React.JSX.Element {
  const dotColor = resolveColorHex(template.color) || 'var(--color-accent)'
  const sessionCount = template.sessions.length
  const terminalCount = template.terminals.length

  return (
    <button
      className={cn('group-picker-card')}
      data-flashing={flashing ? 'true' : undefined}
      onClick={() => onPick(template.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e, template.id)
      }}
      title={template.prompt ? `Starts its sessions on: ${template.prompt}` : template.name}
    >
      <div className="flex items-center gap-2 w-full min-w-0">
        {template.logo ? (
          <img
            src={template.logo}
            alt=""
            className="w-5 h-5 rounded object-contain flex-shrink-0"
          />
        ) : (
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: dotColor }}
          />
        )}
        <span className="flex-1 truncate text-control font-medium text-text-primary">
          {template.name}
        </span>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-text-tertiary">
        <span>
          {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
        </span>
        {terminalCount > 0 && (
          <span className="flex items-center gap-1">
            <CommandLineIcon className="w-3 h-3" />
            {terminalCount}
          </span>
        )}
        {template.prompt && (
          <span className="flex items-center gap-1" title="Has a default prompt">
            <ChatBubbleLeftEllipsisIcon className="w-3 h-3" />
            prompt
          </span>
        )}
      </div>
    </button>
  )
}
