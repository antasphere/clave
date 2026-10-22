import { isRemoteKey, ownerOf } from '../../../src/renderer/src/lib/fleet-identity'
import type { HistoryPage } from '../../../src/shared/session-model'

/** Refresh a remote transcript after a drop. A response cannot overwrite a
 * newer stream event observed while the history request was in flight. */
export function bindFleetCatchup(
  sessionId: string,
  take: (page: HistoryPage) => void
): { changed(): void; close(): void } {
  if (!isRemoteKey(sessionId) || !window.electronAPI.onFleetStatus)
    return { changed: () => undefined, close: () => undefined }
  let gone = false
  let disconnected = false
  let pending = false
  let reading = false
  let sequence = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (delay = 50): void => {
    if (gone || !pending || reading) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void read()
    }, delay)
  }
  const read = async (): Promise<void> => {
    if (gone || !pending || reading) return
    reading = true
    const before = sequence
    try {
      const page = await window.electronAPI.sessionsHistory(sessionId)
      if (gone || !pending) return
      if (before === sequence) {
        pending = false
        take(page)
      }
    } catch {
      /* the connected owner is retried, without local fallback */
    } finally {
      reading = false
      if (pending) schedule(250)
    }
  }
  const stop = window.electronAPI.onFleetStatus((status) => {
    if (status.serverId !== ownerOf(sessionId)) return
    if (status.state !== 'connected') {
      sequence++
      disconnected = true
      pending = false
      return
    }
    if (disconnected) {
      disconnected = false
      pending = true
      schedule()
    }
  })
  return {
    changed: () => {
      sequence++
      if (pending) schedule()
    },
    close: () => {
      gone = true
      stop()
      if (timer !== null) clearTimeout(timer)
    }
  }
}
