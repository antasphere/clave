import { useState, useEffect, useCallback } from 'react'
import { isImageFile } from '../components/files/file-types'
import type { FileReadResult } from '../../../preload/index.d'

interface UseFileEditorParams {
  cwd: string | null
  /** Path as the caller holds it — relative (tree preview) or absolute (file tab); both resolve correctly. */
  filePath: string | null
  /** When set, the file lives on a remote SFTP location (read-only in this version). */
  locationId?: string | null
}

interface UseFileEditor {
  fileData: FileReadResult | null
  filename: string
  content: string
  setContent: (value: string) => void
  isDirty: boolean
  canEdit: boolean
  isImage: boolean
  saving: boolean
  saveError: string | null
  loadError: boolean
  save: () => Promise<void>
}

/**
 * Shared file load + edit + save state for the in-app code surfaces
 * (the floating preview panel and the file tab). Owns the editable buffer so
 * the editor is always live; preserves the safety invariants around binary,
 * truncated, and remote files.
 */
export function useFileEditor({ cwd, filePath, locationId }: UseFileEditorParams): UseFileEditor {
  const [fileData, setFileData] = useState<FileReadResult | null>(null)
  const [content, setContent] = useState('')
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const filename = filePath?.split('/').pop() ?? ''
  const isImage = filePath ? isImageFile(filename) : false
  const isRemote = !!locationId

  // Reset synchronously when the file identity changes (derive, no effect) so
  // consumers never see the previous file's buffer while the new one loads —
  // the page editor reads content once at mount and would keep stale text.
  const fileKey = `${locationId ?? ''}:${cwd ?? ''}:${filePath ?? ''}`
  const [prevFileKey, setPrevFileKey] = useState(fileKey)
  if (fileKey !== prevFileKey) {
    setPrevFileKey(fileKey)
    setFileData(null)
    setContent('')
    setLoadError(false)
  }

  // Load file content
  useEffect(() => {
    if (!filePath || (!cwd && !locationId)) {
      setFileData(null)
      setContent('')
      setLoadError(false)
      return
    }
    if (isImage) {
      setFileData(null)
      setContent('')
      return
    }

    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        let result: FileReadResult | undefined
        if (locationId) {
          const text = await window.electronAPI?.sftpReadFile(locationId, filePath)
          if (text === undefined) return
          result = { content: text, truncated: false, size: text.length, binary: false }
        } else {
          result = await window.electronAPI?.readFile(cwd!, filePath)
        }
        if (cancelled || !result) return
        setFileData(result)
        setContent(result.content)
        setLoadError(false)
      } catch {
        if (!cancelled) setLoadError(true)
      }
    }
    load()

    return () => {
      cancelled = true
    }
  }, [filePath, cwd, locationId, isImage])

  // Reset transient save state when the file changes
  useEffect(() => {
    setSaveError(null)
    setSaving(false)
  }, [filePath])

  const isDirty = !!fileData && !fileData.binary && content !== fileData.content
  const canEdit =
    !!fileData && !fileData.binary && !fileData.truncated && !isImage && !loadError && !isRemote

  const save = useCallback(async () => {
    if (!filePath || !cwd || saving || isRemote) return
    setSaving(true)
    setSaveError(null)
    try {
      await window.electronAPI?.writeFile(cwd, filePath, content)
      const result = await window.electronAPI?.readFile(cwd, filePath)
      if (result) {
        setFileData(result)
        setContent(result.content)
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [filePath, cwd, content, saving, isRemote])

  return {
    fileData,
    filename,
    content,
    setContent,
    isDirty,
    canEdit,
    isImage,
    saving,
    saveError,
    loadError,
    save
  }
}
