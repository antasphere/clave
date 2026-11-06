import { create } from 'zustand'
import type { RoutineRun, RoutineView, RoutinesListing } from '@clave/contract/routines/model'

/**
 * The routines as the server lists them (ADR 0004): a mirror of the
 * server's listing, re-read on every `routines.changed` and at init, the
 * way the copy-offer store mirrors main. The server owns the scheduler and
 * the runs; this store only reads them and asks for a run, a dismissal or a
 * discussion through the bridge.
 */
interface RoutinesState {
  routines: RoutineView[]
  viewer: RoutinesListing['viewer']
  /** The last error a read or an act met, shown in the panel; null when none. */
  error: string | null
  loaded: boolean
  setListing: (listing: RoutinesListing) => void
  refresh: () => Promise<void>
  runNow: (key: string) => Promise<RoutineRun | null>
  dismiss: (runId: string) => Promise<void>
  openDiscussion: (runId: string, mode: 'panel' | 'tab') => Promise<string | null>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const useRoutinesStore = create<RoutinesState>((set, get) => ({
  routines: [],
  viewer: { url: null, note: '' },
  error: null,
  loaded: false,
  setListing: (listing) =>
    set({ routines: [...listing.routines], viewer: listing.viewer, loaded: true }),
  refresh: async () => {
    try {
      get().setListing(await window.electronAPI.routinesList())
    } catch (error) {
      // A window that has not reached the server yet asks again on the next change.
      set({ error: message(error) })
    }
  },
  runNow: async (key) => {
    try {
      const run = await window.electronAPI.routinesRunNow(key)
      set({ error: null })
      return run
    } catch (error) {
      set({ error: message(error) })
      return null
    }
  },
  dismiss: async (runId) => {
    try {
      await window.electronAPI.routinesDismiss(runId)
      set({ error: null })
    } catch (error) {
      set({ error: message(error) })
    }
  },
  openDiscussion: async (runId, mode) => {
    try {
      const { sessionId } = await window.electronAPI.routinesOpenDiscussion(runId, mode)
      set({ error: null })
      return sessionId
    } catch (error) {
      set({ error: message(error) })
      return null
    }
  }
}))

/** Subscribe to the server's changes and read the first listing. */
export function initRoutinesStore(): () => void {
  const store = useRoutinesStore.getState()
  const unsubscribe = window.electronAPI.onRoutinesChanged(() => void store.refresh())
  void store.refresh()
  return unsubscribe
}

/** The latest run of a routine, newest first in the listing. */
export const latestRun = (view: RoutineView): RoutineRun | undefined => view.runs[0]
