import { create } from 'zustand'
import type { SecretRequestView } from '../../../preload/index.d'

/**
 * Transient mirror of the main process's secret-request lifecycle. Main owns
 * the records (they survive renderer reloads); this store only holds the
 * latest snapshot for the toolbar popover. Secret values never enter this
 * store — they live in the popover's local input state until submitted.
 */
interface SecretState {
  requests: SecretRequestView[]
  submittingIds: Set<string>
  setRequests: (requests: SecretRequestView[]) => void
  submit: (id: string, secret: string) => Promise<void>
  dismiss: (id: string) => Promise<void>
}

export const useSecretStore = create<SecretState>((set) => ({
  requests: [],
  submittingIds: new Set<string>(),

  setRequests: (requests) => set({ requests }),

  submit: async (id, secret) => {
    set((s) => ({ submittingIds: new Set(s.submittingIds).add(id) }))
    try {
      await window.electronAPI.secretSubmit(id, secret)
    } finally {
      set((s) => {
        const next = new Set(s.submittingIds)
        next.delete(id)
        return { submittingIds: next }
      })
    }
  },

  dismiss: async (id) => {
    await window.electronAPI.secretDismiss(id)
  }
}))

/** Subscribe to main-process pushes + load the initial snapshot. */
export function initSecretStore(): () => void {
  const unsubscribe = window.electronAPI.onSecretRequestsChanged((requests) => {
    useSecretStore.getState().setRequests(requests)
  })
  window.electronAPI
    .secretList()
    .then((requests) => useSecretStore.getState().setRequests(requests))
    .catch(() => {})
  return unsubscribe
}
