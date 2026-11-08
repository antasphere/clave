import { forwardRef, useCallback, useMemo, useState } from 'react'
import { findPinnedByGroupId, importClaveFile } from '../../store/pinned-store'
import { DocumentIcon } from '@heroicons/react/24/outline'

interface PinnedGroupsGridProps {
  isOverPinnedZone?: boolean
  draggedGroupId?: string | null
  isFileDragOver?: boolean
}

// Pure drop target shown only while dragging a group (to pin it) or dragging a
// .clave file over the sidebar. It no longer lists existing templates inline —
// the full launcher is the GroupPickerDialog behind the Sessions header
// actions, so groups are added exclusively from that picker.
export const PinnedGroupsGrid = forwardRef<HTMLDivElement, PinnedGroupsGridProps>(
  function PinnedGroupsGrid(
    { isOverPinnedZone, draggedGroupId, isFileDragOver: isFileDragOverParent },
    ref
  ) {
    const [isFileDragOverLocal, setIsFileDragOverLocal] = useState(false)
    const isFileDragOver = isFileDragOverParent || isFileDragOverLocal

    // Check if the dragged group is already pinned
    const alreadyPinnedId = useMemo(() => {
      if (!draggedGroupId) return null
      const pg = findPinnedByGroupId(draggedGroupId)
      return pg?.id ?? null
    }, [draggedGroupId])

    // Show placeholder when dragging a group that isn't already pinned
    const showGroupPlaceholder = !!draggedGroupId && !alreadyPinnedId
    const showFilePlaceholder = isFileDragOver

    // ── HTML5 file drop handlers (for .clave files from Finder) ──
    const handleDragOver = useCallback((e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setIsFileDragOverLocal(true)
    }, [])

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      // Only leave if we're actually leaving the container (not entering a child)
      if (e.currentTarget.contains(e.relatedTarget as Node)) return
      setIsFileDragOverLocal(false)
    }, [])

    const handleDrop = useCallback(async (e: React.DragEvent) => {
      e.preventDefault()
      setIsFileDragOverLocal(false)

      const files = e.dataTransfer.files
      if (!files.length) return

      const file = files[0]
      const filePath = window.electronAPI?.getPathForFile(file)
      if (!filePath || !filePath.endsWith('.clave')) return

      // Explicit drop = the pin (and what it launches) joins the ACTIVE workspace.
      const { useWorkspaceStore } = await import('../../store/workspace-store')
      await importClaveFile(filePath, {
        workspaceId: useWorkspaceStore.getState().activeWorkspaceId
      })
    }, [])

    return (
      <div
        ref={ref}
        className="flex-shrink-0"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* px-2 matches the normal tab width so the drop zone aligns with tabs */}
        <div className="px-2 pt-0.5 pb-1 flex flex-col gap-1">
          {(showGroupPlaceholder || showFilePlaceholder) && (
            <div className="grid gap-1.5" style={{ gridTemplateColumns: '1fr' }}>
              {showGroupPlaceholder && (
                <div
                  className={`
                  flex items-center justify-center px-2 py-2 rounded-xl border-2 border-dashed
                  text-[12px] font-medium transition-all duration-150
                  ${
                    isOverPinnedZone
                      ? 'border-accent/60 text-accent/80 bg-accent/10'
                      : 'border-border-subtle/60 text-text-tertiary/50'
                  }
                `}
                >
                  <span className="truncate">{isOverPinnedZone ? 'Drop to pin' : 'Pin'}</span>
                </div>
              )}
              {showFilePlaceholder && !showGroupPlaceholder && (
                <div className="flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl border-2 border-dashed border-accent/60 text-accent/80 bg-accent/10 text-[12px] font-medium transition-all duration-150">
                  <DocumentIcon className="w-3.5 h-3.5" />
                  <span className="truncate">Drop .clave</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }
)
