import { memo } from 'react'
import { useSessionStore, type FileTab } from '../../store/session-store'
import { DocumentTextIcon } from '@heroicons/react/24/outline'
import { CodeBracketSquareIcon } from '@heroicons/react/24/outline'
import { SidebarTabItem } from './SidebarTabItem'

interface FileTabItemProps {
  fileTab: FileTab
  isSelected: boolean
  onClick: (modifiers: { metaKey: boolean; shiftKey: boolean }) => void
  onContextMenu: (e: React.MouseEvent) => void
  grouped?: boolean
  groupSelected?: boolean
  dimmed?: boolean
  forceEditing?: boolean
  onEditingDone?: () => void
  onPointerDown?: (e: React.PointerEvent) => void
  isDragging?: boolean
}

function FileTabItemImpl({
  fileTab,
  isSelected,
  onClick,
  onContextMenu,
  grouped,
  groupSelected,
  dimmed,
  forceEditing,
  onEditingDone,
  onPointerDown,
  isDragging
}: FileTabItemProps): React.JSX.Element {
  const renameFileTab = useSessionStore((s) => s.renameFileTab)
  const removeFileTab = useSessionStore((s) => s.removeFileTab)

  const isDiff = fileTab.kind === 'diff'
  const titleSuffix = isDiff
    ? fileTab.diff?.type === 'commit'
      ? ` (diff @ ${fileTab.diff.hash?.slice(0, 7) ?? 'commit'})`
      : fileTab.diff?.staged
        ? ' (staged diff)'
        : ' (diff)'
    : ''

  return (
    <SidebarTabItem
      id={fileTab.id}
      name={fileTab.name}
      title={`${fileTab.filePath.replace(/^\/Users\/[^/]+/, '~')}${titleSuffix}`}
      isSelected={isSelected}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onRename={renameFileTab}
      onDelete={() => removeFileTab(fileTab.id)}
      icon={
        <span className="sidebar-tab-icon flex-shrink-0">
          {isDiff ? (
            <CodeBracketSquareIcon />
          ) : (
            <DocumentTextIcon />
          )}
        </span>
      }
      grouped={grouped}
      groupSelected={groupSelected}
      dimmed={dimmed}
      forceEditing={forceEditing}
      onEditingDone={onEditingDone}
      onPointerDown={onPointerDown}
      isDragging={isDragging}
    />
  )
}

// See SessionItem: inline callbacks are thin wrappers over stable handlers, so
// only the data object and scalar props are compared.
export const FileTabItem = memo(FileTabItemImpl, (prev, next) => {
  return (
    prev.fileTab === next.fileTab &&
    prev.isSelected === next.isSelected &&
    prev.grouped === next.grouped &&
    prev.groupSelected === next.groupSelected &&
    prev.dimmed === next.dimmed &&
    prev.forceEditing === next.forceEditing &&
    prev.isDragging === next.isDragging
  )
})
