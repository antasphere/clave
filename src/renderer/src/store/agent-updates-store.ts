import { create } from 'zustand'
import type { AgentUpdateId, AgentUpdatesState } from '../../../shared/agent-updates'

/**
 * The renderer's mirror of the agent updater (`src/main/agent-updates/`).
 * Main decides everything; this store reflects the state it pushes and
 * forwards the three verbs. Pulled on connect, like the app updater's store,
 * so a window that mounts late still knows the truth.
 */
interface AgentUpdatesStore extends AgentUpdatesState {
  /** Per tab, the upgrade whose restart hint was put away (its `lastUpdatedAt`).
   *  Renderer-only; a later upgrade brings the hint back. */
  dismissedHints: Record<string, number>
  dismissHint: (sessionId: string, updatedAt: number) => void
  applyState: (state: AgentUpdatesState) => void
  hydrate: () => Promise<void>
  check: () => Promise<void>
  update: (id: AgentUpdateId) => Promise<void>
  setAutoUpdate: (enabled: boolean) => Promise<void>
}

export const useAgentUpdatesStore = create<AgentUpdatesStore>((set, get) => ({
  supported: true,
  autoUpdate: true,
  busy: false,
  agents: [],
  dismissedHints: {},

  dismissHint: (sessionId, updatedAt) =>
    set((state) => ({ dismissedHints: { ...state.dismissedHints, [sessionId]: updatedAt } })),

  applyState: (state) => set(state),

  hydrate: async () => {
    const state = await window.electronAPI?.getAgentUpdates?.()
    if (state) get().applyState(state)
  },

  check: async () => {
    const state = await window.electronAPI?.checkAgentUpdates?.()
    if (state) get().applyState(state)
  },

  update: async (id) => {
    const state = await window.electronAPI?.updateAgent?.(id)
    if (state) get().applyState(state)
  },

  setAutoUpdate: async (enabled) => {
    const state = await window.electronAPI?.setAgentAutoUpdate?.(enabled)
    if (state) get().applyState(state)
  }
}))

declare global {
  interface Window {
    /** E2E seam, the same as the updater store's: gated on the test flag. */
    __claveAgentUpdatesStoreForTests?: typeof useAgentUpdatesStore
  }
}

if (typeof window !== 'undefined' && window.__claveTestMode) {
  window.__claveAgentUpdatesStoreForTests = useAgentUpdatesStore
}

/** Subscribe once, from the app shell, and pull the current truth. */
export function connectAgentUpdatesStore(): () => void {
  const { hydrate, applyState } = useAgentUpdatesStore.getState()
  void hydrate()
  return window.electronAPI?.onAgentUpdatesState?.(applyState) ?? ((): void => {})
}
