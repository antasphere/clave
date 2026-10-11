import { useCallback } from 'react'
import { create } from 'zustand'

/** What the reader has typed into a session's composer and not sent, held by
 *  the host per session rather than by the view. A view is unmounted whenever
 *  the pane falls back to the terminal, and until PRDCT-2620 that happened on
 *  every plugin reload (a plugin linked, a linked plugin's files changed: every
 *  plugin restarts and reads as starting for about a hundred milliseconds), so a
 *  draft kept in the view's own state went with it, under the keystroke. Here it
 *  outlives the view: a composer that comes back finds its text. Every view of
 *  a session reads the same entry, so a switch from the chat view to the terminal
 *  one finds the same draft.
 *
 *  It also outlives the APP: every draft is written to localStorage under its
 *  session id, so a quit or an update with a prompt typed and not sent finds it
 *  again in the restored tab, which keeps its id (`adopt-record.ts`,
 *  `adoptSessionId`). localStorage rather than the main-process preference
 *  file: a draft changes on every keystroke, and the write must be synchronous
 *  to survive a quit that tears the renderer down mid-IPC. Main flushes the
 *  storage to disk in `before-quit` (`flushStorageData`), since Chromium
 *  otherwise commits it lazily. One key per session, never one map, so two
 *  windows typing at once cannot overwrite each other's drafts; a tab moved to
 *  another window picks its draft up through the `storage` event. */
interface DraftState {
  drafts: Record<string, string>
}

/** The prefix of every draft's localStorage key; the session id follows it. */
export const DRAFT_KEY_PREFIX = 'clave-draft:'
/** A draft nobody touched for this long belongs to a tab that never came back
 *  (its restore declined, its record gone): it is dropped on the next boot. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** The part of the Web Storage API the drafts use, so a test can hand one in. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

const browserStorage = (): DraftStorage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
let storage: DraftStorage | null = browserStorage()

interface Stored {
  text: string
  at: number
}
function parseStored(raw: string | null): Stored | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<Stored>
    if (typeof value?.text !== 'string' || typeof value.at !== 'number') return null
    return { text: value.text, at: value.at }
  } catch {
    return null
  }
}

/** Every persisted draft still young enough to keep; stale and malformed
 *  entries are removed as they are read. */
export function readPersistedDrafts(
  from: DraftStorage | null = storage,
  now: number = Date.now()
): Record<string, string> {
  const drafts: Record<string, string> = {}
  if (!from) return drafts
  const keys: string[] = []
  try {
    for (let i = 0; i < from.length; i++) {
      const key = from.key(i)
      if (key?.startsWith(DRAFT_KEY_PREFIX)) keys.push(key)
    }
    for (const key of keys) {
      const stored = parseStored(from.getItem(key))
      if (!stored || !stored.text || now - stored.at > DRAFT_MAX_AGE_MS) {
        from.removeItem(key)
        continue
      }
      drafts[key.slice(DRAFT_KEY_PREFIX.length)] = stored.text
    }
  } catch {
    // Storage unavailable or full: the drafts simply start empty.
  }
  return drafts
}

function persist(sessionId: string, text: string): void {
  if (!storage) return
  try {
    if (text)
      storage.setItem(DRAFT_KEY_PREFIX + sessionId, JSON.stringify({ text, at: Date.now() }))
    else storage.removeItem(DRAFT_KEY_PREFIX + sessionId)
  } catch {
    // A full or unavailable storage costs the draft's persistence, never the keystroke.
  }
}

export const useDraftStore = create<DraftState>(() => ({ drafts: readPersistedDrafts() }))

/** Point the store at another storage and reload from it: for tests only. */
export function setDraftStorageForTests(next: DraftStorage | null): void {
  storage = next
  useDraftStore.setState({ drafts: readPersistedDrafts(next) })
}

// Another window wrote a draft (a tab moved there, or the same tab's draft
// changed while this window holds a stale copy): take the new text.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (!event.key?.startsWith(DRAFT_KEY_PREFIX)) return
    const sessionId = event.key.slice(DRAFT_KEY_PREFIX.length)
    const text = parseStored(event.newValue)?.text ?? ''
    useDraftStore.setState((state) => {
      if ((state.drafts[sessionId] ?? '') === text) return state
      const drafts = { ...state.drafts }
      if (text) drafts[sessionId] = text
      else delete drafts[sessionId]
      return { drafts }
    })
  })
}

type Update = string | ((current: string) => string)

export function setSessionDraft(sessionId: string, next: Update): void {
  let changed: string | null = null
  useDraftStore.setState((state) => {
    const current = state.drafts[sessionId] ?? ''
    const value = typeof next === 'function' ? next(current) : next
    if (value === current) return state
    changed = value
    return { drafts: { ...state.drafts, [sessionId]: value } }
  })
  if (changed !== null) persist(sessionId, changed)
}
/** Drop a session's draft, when the session itself is closed. */
export function clearSessionDraft(sessionId: string): void {
  persist(sessionId, '')
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
