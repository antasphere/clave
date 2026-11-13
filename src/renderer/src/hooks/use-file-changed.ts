import { useEffect, useRef } from 'react'
import { fileWatchRegistry } from '../lib/watch-registry'

/**
 * Calls back when a file on disk changes. Rides the main process's per-file
 * watcher (a directory watch that survives an editor's atomic rename), which
 * holds ONE watcher per path; the registry counts the consumers so the first
 * one in starts it and the last one out stops it.
 *
 * With `reconcile`, `onChange` is also called ONE time once the watch on the
 * path is set, whoever asked for it, provided the consumer still shows that
 * path. Setting a watch takes a moment (more with the server apart from the
 * app), and an edit made between the consumer showing the file and the watch
 * being set would otherwise be seen only at the next edit. A watch that could
 * not be set calls nothing. Only a consumer whose handler is cheap when the
 * file did not change should ask for it.
 */
export function useFileChanged(
  absPath: string | null,
  onChange: () => void,
  options?: { reconcile?: boolean }
): void {
  const cb = useRef(onChange)
  useEffect(() => {
    cb.current = onChange
  }, [onChange])
  const reconcile = options?.reconcile === true

  useEffect(() => {
    if (!absPath) return
    let mounted = true
    fileWatchRegistry.acquire(absPath, () => window.electronAPI.watchClaveFile(absPath))
    const off = window.electronAPI.onClaveFileChanged((changed) => {
      if (changed === absPath) cb.current()
    })
    if (reconcile)
      fileWatchRegistry.watch(absPath)?.then(
        () => {
          if (mounted) cb.current()
        },
        () => {}
      )
    return () => {
      mounted = false
      off()
      if (fileWatchRegistry.release(absPath)) void window.electronAPI.unwatchClaveFile(absPath)
    }
  }, [absPath, reconcile])
}
