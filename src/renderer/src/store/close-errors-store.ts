import { create } from 'zustand'
import { useSessionStore } from './session-store'

/**
 * Why a tab is back in the sidebar after its close failed (PRDCT-5315): the
 * row left at once, its server refused or never answered the stop, and the
 * tab came back with this sentence on the mark before its title. Kept beside
 * the session store rather than on the session, because a server's snapshot
 * rebuilds that server's sessions from its own record and would drop a field
 * it does not know. Cleared when the tab leaves the store, whichever way it
 * leaves: closed again, dropped by its server's snapshot, ended from Ongoing.
 */
interface CloseErrorsState {
  errors: Record<string, string>
}

export const useCloseErrorsStore = create<CloseErrorsState>(() => ({ errors: {} }))

export function setCloseError(sessionId: string, message: string): void {
  watchTabs()
  useCloseErrorsStore.setState((state) => ({ errors: { ...state.errors, [sessionId]: message } }))
}

export function clearCloseError(sessionId: string): void {
  useCloseErrorsStore.setState((state) => {
    if (!(sessionId in state.errors)) return state
    const errors = { ...state.errors }
    delete errors[sessionId]
    return { errors }
  })
}

/** The sentence on a tab's mark, or null when its last close did not fail. */
export function useCloseError(sessionId: string): string | null {
  return useCloseErrorsStore((state) => state.errors[sessionId] ?? null)
}

// A mark lives exactly as long as its tab: a tab that leaves the store by any
// road takes its mark with it, so the same id listed again later (a server
// back after a restart) is drawn without a reason that no longer holds. The
// watch starts with the first mark, never at import: a module that merely
// imports this one (a test with the session store stubbed) subscribes nothing.
let watching = false
function watchTabs(): void {
  if (watching) return
  watching = true
  useSessionStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return
    const errors = useCloseErrorsStore.getState().errors
    const marked = Object.keys(errors)
    if (marked.length === 0) return
    const present = new Set(state.sessions.map((s) => s.id))
    const gone = marked.filter((id) => !present.has(id))
    if (gone.length === 0) return
    const next = { ...errors }
    for (const id of gone) delete next[id]
    useCloseErrorsStore.setState({ errors: next })
  })
}
