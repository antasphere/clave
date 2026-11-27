import { create } from 'zustand'

/**
 * Why a tab is back in the sidebar after its close failed (PRDCT-5315): the
 * row left at once, its server refused or never answered the stop, and the
 * tab came back with this sentence on the mark before its title. Kept beside
 * the session store rather than on the session, because a server's snapshot
 * rebuilds that server's sessions from its own record and would drop a field
 * it does not know. Cleared when the tab closes for good.
 */
interface CloseErrorsState {
  errors: Record<string, string>
}

export const useCloseErrorsStore = create<CloseErrorsState>(() => ({ errors: {} }))

export function setCloseError(sessionId: string, message: string): void {
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
