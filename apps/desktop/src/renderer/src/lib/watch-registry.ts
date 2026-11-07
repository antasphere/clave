/**
 * Who is watching which path. The main process holds ONE watcher per file, so
 * a second consumer of the same path (a file tab and the tree's preview on the
 * same .html) would tear the first one's watcher down on unmount; this count
 * lets the first consumer in start the watcher and the last one out stop it.
 * Pure, so the arithmetic is testable without a window.
 */
export interface WatchRegistry {
  /** True when this is the first consumer of `path`: start the watcher. */
  acquire: (path: string) => boolean
  /** True when this was the last consumer of `path`: stop the watcher. */
  release: (path: string) => boolean
  count: (path: string) => number
}

export function createWatchRegistry(): WatchRegistry {
  const counts = new Map<string, number>()
  return {
    acquire(path) {
      const n = (counts.get(path) ?? 0) + 1
      counts.set(path, n)
      return n === 1
    },
    release(path) {
      const n = (counts.get(path) ?? 0) - 1
      if (n <= 0) {
        counts.delete(path)
        return true
      }
      counts.set(path, n)
      return false
    },
    count: (path) => counts.get(path) ?? 0
  }
}

export const fileWatchRegistry = createWatchRegistry()
