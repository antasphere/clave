import { create } from 'zustand'
import type { OngoingEntry } from '../lib/ongoing'

/**
 * The ongoing conversations (PRDCT-4190), every workspace's in one list,
 * kept in the app's preferences under one key. Each window holds a copy:
 * every change reads the saved list first and writes it back with the one
 * change applied, so two windows editing different entries never undo each
 * other, and a window refreshes its copy when it is focused again.
 */

export const ONGOING_PREF_KEY = 'ongoingConversations'

interface OngoingStore {
  entries: OngoingEntry[]
  /** True once the saved list has been read: the boot waits on it before it
   *  decides which dead tabs to offer back. */
  hydrated: boolean
  hydrate: () => Promise<void>
  /** Apply one change to the saved list and keep the result. */
  update: (change: (entries: OngoingEntry[]) => OngoingEntry[]) => Promise<void>
}

function sanitize(raw: unknown): OngoingEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (e): e is OngoingEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as OngoingEntry).id === 'string' &&
      typeof (e as OngoingEntry).sessionId === 'string' &&
      typeof (e as OngoingEntry).conversationId === 'string' &&
      ((e as OngoingEntry).provider === 'claude' || (e as OngoingEntry).provider === 'pi')
  )
}

async function readSaved(): Promise<OngoingEntry[] | null> {
  try {
    const raw = await window.electronAPI?.preferencesGet(ONGOING_PREF_KEY)
    return sanitize(raw)
  } catch {
    return null
  }
}

/** Changes run one after the other: each reads what the last one wrote. */
let queue: Promise<void> = Promise.resolve()

export const useOngoingStore = create<OngoingStore>((set, get) => ({
  entries: [],
  hydrated: false,
  hydrate: async () => {
    const saved = await readSaved()
    set({ entries: saved ?? get().entries, hydrated: true })
  },
  update: (change) => {
    // The change shows at once (the row leaves the sidebar on the click),
    // and is then applied again over what is saved, so a change another
    // window made in between is kept.
    set({ entries: change(get().entries) })
    const run = queue.then(async () => {
      const saved = (await readSaved()) ?? get().entries
      const next = change(saved)
      try {
        await window.electronAPI?.preferencesSet(ONGOING_PREF_KEY, next)
      } catch (err) {
        console.error('Could not save the ongoing conversations:', err)
      }
      set({ entries: next })
    })
    queue = run.catch(() => {})
    return run
  }
}))

/** Refresh the window's copy when it comes back to the front: another window
 *  may have moved a conversation in or out in the meantime. */
export function startOngoingSync(): () => void {
  const onFocus = (): void => {
    void readSaved().then((saved) => {
      if (saved) useOngoingStore.setState({ entries: saved })
    })
  }
  window.addEventListener('focus', onFocus)
  return () => window.removeEventListener('focus', onFocus)
}

export function newOngoingId(): string {
  return `ongoing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
