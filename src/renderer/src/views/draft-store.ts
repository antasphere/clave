import { useCallback } from 'react'
import { create } from 'zustand'

/** What the reader has typed into a session's composer and not sent, held by
 *  the host per session rather than by the view. A view is unmounted whenever
 *  the pane falls back to the terminal, and until PRDCT-2620 that happened on
 *  every plugin reload (a plugin linked, a linked plugin's files changed: every
 *  plugin restarts and reads as starting for about a hundred milliseconds), so a
 *  draft kept in the view's own state went with it, under the keystroke. Here it
 *  outlives the view: a composer that comes back finds its text. Every view of
 *  a session reads the same entry, so a switch from the chat view to the compact
 *  one finds the same draft. */
interface DraftState {
  drafts: Record<string, string>
}
export const useDraftStore = create<DraftState>(() => ({ drafts: {} }))

type Update = string | ((current: string) => string)

export function setSessionDraft(sessionId: string, next: Update): void {
  useDraftStore.setState((state) => {
    const current = state.drafts[sessionId] ?? ''
    const value = typeof next === 'function' ? next(current) : next
    if (value === current) return state
    return { drafts: { ...state.drafts, [sessionId]: value } }
  })
}
/** Drop a session's draft, when the session itself is closed. */
export function clearSessionDraft(sessionId: string): void {
  useDraftStore.setState((state) => {
    if (!(sessionId in state.drafts)) return state
    const drafts = { ...state.drafts }
    delete drafts[sessionId]
    return { drafts }
  })
}
/** The composer's value and setter for one session, in the shape `useState`
 *  gave the views, functional updates included. */
export function useSessionDraft(sessionId: string): [string, (next: Update) => void] {
  const draft = useDraftStore((state) => state.drafts[sessionId] ?? '')
  const set = useCallback((next: Update) => setSessionDraft(sessionId, next), [sessionId])
  return [draft, set]
}
