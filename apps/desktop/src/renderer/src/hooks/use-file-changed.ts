import { useEffect, useRef } from 'react'
import { fileWatchRegistry } from '../lib/watch-registry'

/**
 * Calls back when a file on disk changes. Rides the main process's per-file
 * watcher (a directory watch that survives an editor's atomic rename), which
 * holds ONE watcher per path; the registry counts the consumers so the first
 * one in starts it and the last one out stops it.
 */
export function useFileChanged(absPath: string | null, onChange: () => void): void {
  const cb = useRef(onChange)
  useEffect(() => {
    cb.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!absPath) return
    if (fileWatchRegistry.acquire(absPath)) void window.electronAPI.watchClaveFile(absPath)
    const off = window.electronAPI.onClaveFileChanged((changed) => {
      if (changed === absPath) cb.current()
    })
    return () => {
      off()
      if (fileWatchRegistry.release(absPath)) void window.electronAPI.unwatchClaveFile(absPath)
    }
  }, [absPath])
}
