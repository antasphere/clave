import { cn } from '@clave/ui/components'

interface SidebarItemProps {
  icon: React.ReactNode
  label: string
  isSelected: boolean
  onClick: () => void
  rightContent?: React.ReactNode
  className?: string
}

export function SidebarItem({
  icon,
  label,
  isSelected,
  onClick,
  rightContent,
  className
}: SidebarItemProps) {
  return (
    <button
      onClick={onClick}
      data-selected={isSelected ? 'true' : undefined}
      className={cn('sidebar-item', className)}
    >
      {icon}
      <span className="truncate">{label}</span>
      {rightContent && <span className="ml-auto">{rightContent}</span>}
    </button>
  )
}
