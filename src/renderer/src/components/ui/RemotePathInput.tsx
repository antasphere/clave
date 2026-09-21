import { useState, useCallback } from 'react'

interface RemotePathInputProps {
  defaultPath?: string
  onSubmit: (path: string) => void
  onCancel: () => void
}

export function RemotePathInput({ defaultPath = '~', onSubmit, onCancel }: RemotePathInputProps) {
  const [path, setPath] = useState(defaultPath)

  const handleSubmit = useCallback(() => {
    const trimmed = path.trim()
    if (trimmed) onSubmit(trimmed)
  }, [path, onSubmit])

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Remote path (e.g. ~/projects)"
        className="flex-1 h-control-md px-2 rounded-lg bg-surface-100 border border-border-subtle text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-accent transition-colors"
        autoFocus
      />
      <button
        onClick={handleSubmit}
        className="h-control-md px-3 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors"
      >
        Open
      </button>
      <button
        onClick={onCancel}
        className="h-control-md px-2 rounded-lg text-xs text-text-tertiary hover:text-text-primary hover:bg-surface-200 transition-colors"
      >
        Cancel
      </button>
    </div>
  )
}
