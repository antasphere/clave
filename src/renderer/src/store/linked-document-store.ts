import { create } from 'zustand'
import type { LinkedDocument } from '../../../shared/linked-documents'
let requestVersion = 0
export const useLinkedDocumentStore = create<{
  documents: LinkedDocument[]
  refresh: () => Promise<void>
}>((set) => ({
  documents: [],
  refresh: async () => {
    const version = ++requestVersion
    const documents = await window.electronAPI.linkedDocuments.list()
    if (version === requestVersion) set({ documents })
  }
}))
export function initLinkedDocuments(): () => void {
  const refresh = (): void => {
    void useLinkedDocumentStore.getState().refresh().catch(console.error)
  }
  const off = window.electronAPI.linkedDocuments.onChanged(refresh)
  refresh()
  return off
}

const closeGuards = new Map<string, () => boolean>()
export function linkedEditorBlocksClose(sessionId: string): boolean {
  return closeGuards.get(sessionId)?.() ?? false
}

const flushers = new Map<string, (allowConflict?: boolean) => Promise<void>>()
export function registerLinkedFlusher(
  sessionId: string,
  flush: (allowConflict?: boolean) => Promise<void>,
  blocksClose: () => boolean
): () => void {
  flushers.set(sessionId, flush)
  closeGuards.set(sessionId, blocksClose)
  return () => {
    if (flushers.get(sessionId) === flush) {
      flushers.delete(sessionId)
      closeGuards.delete(sessionId)
    }
  }
}
/** Whether a linked document's panel is mounted for the tab, with edits it
 *  may still have to save (PRDCT-5315: the close waits for them only then). */
export function hasLinkedFlusher(sessionId: string): boolean {
  return flushers.has(sessionId)
}
export async function flushLinkedDocument(sessionId: string, allowConflict = false): Promise<void> {
  await flushers.get(sessionId)?.(allowConflict)
}
