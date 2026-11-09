import { create } from 'zustand'
import type { OngoingEntry } from '../lib/ongoing'

/**
 * The ongoing conversations (PRDCT-4190), every workspace's in one list,
 * kept in the app's preferences under one key. Each window holds a copy:
 * every change reads the saved list first and writes it back with the one
 * change applied, so two windows editing different entries never undo each
 * other, and a window refreshes its copy when it is focused again. The read
 * and the write run under a lock every window shares (PRDCT-4208), so two
 * windows saving at the same instant never write from the same stale read.
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
  // No preferences to read (a window without the bridge): nothing is known,
  // which is not the same as an empty list.
  const get = window.electronAPI?.preferencesGet
  if (!get) return null
  try {
    const raw = await get(ONGOING_PREF_KEY)
    return sanitize(raw)
  } catch {
    return null
  }
}

export const ONGOING_LOCK = 'clave-ongoing-conversations'

/** Run `work` holding the lock the app's windows share: every window is a
 *  renderer of the same origin, so the Web Locks API serialises them. A
 *  window without it (a test, an unsupported context) runs unlocked, as
 *  before; a refused request runs unlocked too, so a save is never lost to
 *  the lock itself. */
export async function withSharedLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) return work()
  let ran = false
  try {
    return await locks.request(ONGOING_LOCK, () => {
      ran = true
      return work()
    })
  } catch (err) {
    if (ran) throw err
    return work()
  }
}

/** Changes run one after the other: each reads what the last one wrote. */
let queue: Promise<void> = Promise.resolve()
/** Changes not yet written: a read of the saved list meanwhile would show the
 *  window a state its own change has already moved past. */
let pending = 0

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
    pending++
    const run = queue.then(async () => {
      const next = await withSharedLock(async () => {
        const saved = (await readSaved()) ?? get().entries
        const applied = change(saved)
        try {
          await window.electronAPI?.preferencesSet(ONGOING_PREF_KEY, applied)
        } catch (err) {
          console.error('Could not save the ongoing conversations:', err)
        }
        return applied
      })
      set({ entries: next })
      announce()
    })
    queue = run
      .catch(() => {})
      .finally(() => {
        pending--
      })
    return run
  }
}))

/** The windows of this app tell each other when the list changed: every
 *  window is a renderer of the same origin, so one channel reaches them all. */
let channel: BroadcastChannel | null = null
function post(message: unknown): void {
  try {
    channel?.postMessage(message)
  } catch {
    // a closed channel: the focus refresh still catches up
  }
}
function announce(): void {
  post('changed')
}

/** Tell the other windows a tab was ended from here while it ran there (its
 *  move was refused): the window holding it drops its row (PRDCT-4208). */
export function announceEnded(sessionId: string): void {
  post({ ended: sessionId })
}

/** What another window's message asks of this one: a tab it ended to drop,
 *  else a refresh of the list. */
export function endedOf(message: unknown): string | null {
  const ended = (message as { ended?: unknown } | null)?.ended
  return typeof ended === 'string' && ended ? ended : null
}

/** Refresh the window's copy when another window changed the list, and when
 *  it comes back to the front (a change it could not hear). `onEnded` drops
 *  a tab another window ended while this one held it. */
export function startOngoingSync(onEnded?: (sessionId: string) => void): () => void {
  const refresh = (): void => {
    if (pending > 0) return
    void readSaved().then((saved) => {
      if (saved && pending === 0) useOngoingStore.setState({ entries: saved })
    })
  }
  window.addEventListener('focus', refresh)
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(ONGOING_LOCK)
    channel.onmessage = (event: MessageEvent) => {
      const ended = endedOf(event.data)
      if (ended) onEnded?.(ended)
      else refresh()
    }
  }
  return () => {
    window.removeEventListener('focus', refresh)
    channel?.close()
    channel = null
  }
}

export function newOngoingId(): string {
  return `ongoing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
