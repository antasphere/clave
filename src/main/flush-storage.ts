import { session } from 'electron'

/**
 * Write the renderers' localStorage to disk now. Chromium commits it lazily,
 * and the composer drafts live there (`views/draft-store.ts`): a quit or an
 * update that ends the process before the commit would lose the prompt the
 * reader typed and did not send. Called at the start of the quit and right
 * before an update's `quitAndInstall`. Never throws: a failed flush costs a
 * draft, never the quit.
 */
export function flushRendererStorage(): void {
  try {
    session.defaultSession.flushStorageData()
  } catch (error) {
    console.error('[quit] flushing renderer storage failed:', error)
  }
}
