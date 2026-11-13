/**
 * Who is watching which path. The main process holds ONE watcher per file, so
 * a second consumer of the same path (a file tab and the tree's preview on the
 * same .html) would tear the first one's watcher down on unmount; this count
 * lets the first consumer in start the watcher and the last one out stop it.
 *
 * The registry also keeps the promise of the watch the first consumer
 * started, so any consumer can tell when the watch IS set: asking for a
 * watch on a server apart from the app takes a moment, and a consumer that
 * reads the file again once the watch is set sees an edit made in that
 * moment. A second consumer of a watch already set gets the same settled
 * promise, so it can read again at once. Pure, so the arithmetic is
 * testable without a window.
 */
export interface WatchRegistry {
  /**
   * True when this is the first consumer of `path`: start the watcher. Given
   * `start`, the first consumer calls it here and its promise is kept for the
   * path until the last consumer leaves.
   */
  acquire: (path: string, start?: () => Promise<unknown>) => boolean
  /** True when this was the last consumer of `path`: stop the watcher. */
  release: (path: string) => boolean
  count: (path: string) => number
  /** The promise of the watch on `path`, settled once it is set or refused. */
  watch: (path: string) => Promise<unknown> | undefined
}

export function createWatchRegistry(): WatchRegistry {
  const counts = new Map<string, number>()
  const watches = new Map<string, Promise<unknown>>()
  return {
    acquire(path, start) {
      const n = (counts.get(path) ?? 0) + 1
      counts.set(path, n)
      if (n === 1 && start) {
        const started = start()
        // A watch that could not be set is told to whoever asks through
        // `watch()`; with nobody asking, it must not surface as an
        // unhandled rejection.
        started.catch(() => undefined)
        watches.set(path, started)
      }
      return n === 1
    },
    release(path) {
      const n = (counts.get(path) ?? 0) - 1
      if (n <= 0) {
        counts.delete(path)
        watches.delete(path)
        return true
      }
      counts.set(path, n)
      return false
    },
    count: (path) => counts.get(path) ?? 0,
    watch: (path) => watches.get(path)
  }
}

export const fileWatchRegistry = createWatchRegistry()
