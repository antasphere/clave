import { create } from 'zustand'
import type { CopyOfferView } from '../../../preload/index.d'

/**
 * Transient mirror of the main process's copy-offer records (agent-offered
 * click-to-copy values). Main owns the full values — this store only ever
 * holds previews; copying asks main to write the stored bytes to the OS
 * clipboard directly, so the renderer never touches the value itself.
 */
interface CopyOfferState {
  offers: CopyOfferView[]
  setOffers: (offers: CopyOfferView[]) => void
  copy: (id: string) => Promise<void>
  dismiss: (id: string) => Promise<void>
  dismissSession: (sessionId: string) => Promise<void>
}

export const useCopyOfferStore = create<CopyOfferState>((set) => ({
  offers: [],

  setOffers: (offers) => set({ offers }),

  copy: async (id) => {
    await window.electronAPI.copyOfferCopy(id)
  },

  dismiss: async (id) => {
    await window.electronAPI.copyOfferDismiss(id)
  },

  dismissSession: async (sessionId) => {
    await window.electronAPI.copyOfferDismissSession(sessionId)
  }
}))

/** Subscribe to main-process pushes + load the initial snapshot. */
export function initCopyOfferStore(): () => void {
  const unsubscribe = window.electronAPI.onCopyOffersChanged((offers) => {
    useCopyOfferStore.getState().setOffers(offers)
  })
  window.electronAPI
    .copyOfferList()
    .then((offers) => useCopyOfferStore.getState().setOffers(offers))
    .catch(() => {})
  return unsubscribe
}
