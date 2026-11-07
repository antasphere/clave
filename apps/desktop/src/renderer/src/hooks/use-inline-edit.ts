import { useCallback, useEffect, useRef, useState } from 'react'

interface UseInlineEditOptions {
  name: string
  onCommit: (newName: string) => void
  onEditingDone?: () => void
  forceEditing?: boolean
}

interface UseInlineEditResult {
  editing: boolean
  editValue: string
  inputRef: React.RefObject<HTMLInputElement | null>
  setEditValue: (value: string) => void
  startEditing: () => void
  commitRename: () => void
  cancelRename: () => void
  handleDoubleClick: (e: React.MouseEvent) => void
  handleInputKeyDown: (e: React.KeyboardEvent) => void
  handleButtonKeyDown: (e: React.KeyboardEvent) => void
}

export function useInlineEdit({
  name,
  onCommit,
  onEditingDone,
  forceEditing
}: UseInlineEditOptions): UseInlineEditResult {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  const [prevForceEditing, setPrevForceEditing] = useState(false)

  // Adjust editing state when forceEditing prop changes (render-time pattern)
  if (!!forceEditing !== prevForceEditing) {
    setPrevForceEditing(!!forceEditing)
    if (forceEditing && !editing) {
      setEditValue(name)
      setEditing(true)
    }
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commitRename = useCallback(() => {
    onCommit(editValue)
    setEditing(false)
    onEditingDone?.()
  }, [editValue, onCommit, onEditingDone])

  const cancelRename = useCallback(() => {
    setEditValue(name)
    setEditing(false)
    onEditingDone?.()
  }, [name, onEditingDone])

  const startEditing = useCallback(() => {
    setEditValue(name)
    setEditing(true)
  }, [name])

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      startEditing()
    },
    [startEditing]
  )

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitRename()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelRename()
      }
    },
    [commitRename, cancelRename]
  )

  const handleButtonKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !editing) {
        e.preventDefault()
        startEditing()
      } else if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'r' && !editing) {
        e.preventDefault()
        startEditing()
      }
    },
    [editing, startEditing]
  )

  return {
    editing,
    editValue,
    inputRef,
    setEditValue,
    startEditing,
    commitRename,
    cancelRename,
    handleDoubleClick,
    handleInputKeyDown,
    handleButtonKeyDown
  }
}
