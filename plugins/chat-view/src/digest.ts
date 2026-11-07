import { useEffect } from 'react'
import { create } from 'zustand'
import type {
  DigestDone,
  DigestLaunch,
  DigestMessage,
  DigestResult
} from '../../../src/shared/exchange-digest'

/**
 * The exchange digests on the view's side. Main reads them and files them by
 * the tab's session id (src/main/exchange-digest-store.ts), so each is read
 * once: a remount, a restart and both views of the tab find it there. Here,
 * one store says where each timeline's digest stands, by session and key:
 *
 *  - the view asks, not the timeline on screen (`useTimelineDigests`): the
 *    rows are virtualised, and a digest must not wait for its card to be
 *    scrolled to, nor start again when the card is scrolled away and back;
 *  - opening a tab loads every digest filed for it, at once;
 *  - a digest not filed yet is asked for once its timeline has held still for
 *    DIGEST_SETTLE_MS, and goes on to the end whatever the reader does, so it
 *    is filed even if they left;
 *  - a timeline stops saying it reads after DIGEST_GIVE_UP_MS.
 */

/** How long a timeline must hold still before its digest is asked for: a
 *  burst of messages is read once, at its end, not once per message. */
export const DIGEST_SETTLE_MS = 2500
/** How long a digest may be read before the timeline stops saying so. */
export const DIGEST_GIVE_UP_MS = 90_000

export type DigestState =
  /** Not read, and not to be: an older timeline (`Exchanges.recent`). */
  | { state: 'off' }
  | { state: 'waiting' }
  | { state: 'reading' }
  /** `fresh`: read while the reader was here, rather than found filed. */
  | { state: 'done'; result: DigestDone; fresh?: boolean }
  | { state: 'failed' }

interface DigestStore {
  states: Record<string, DigestState | undefined>
  loaded: Record<string, true | undefined>
  set: (id: string, state: DigestState) => void
  file: (sessionId: string, filed: Record<string, DigestDone>) => void
}

const idOf = (sessionId: string, key: string): string => `${sessionId}|${key}`

export const useDigestStore = create<DigestStore>((set) => ({
  states: {},
  loaded: {},
  set: (id, state) => set((s) => ({ states: { ...s.states, [id]: state } })),
  file: (sessionId, filed) =>
    set((s) => {
      const states = { ...s.states }
      for (const [key, result] of Object.entries(filed)) {
        const id = idOf(sessionId, key)
        if (states[id]?.state !== 'done') states[id] = { state: 'done', result }
      }
      return { states, loaded: { ...s.loaded, [sessionId]: true } }
    })
}))

/** Where a timeline's digest stands, for its head. */
export function useDigestState(sessionId: string, key: string, enabled: boolean): DigestState {
  const state = useDigestStore((s) => s.states[idOf(sessionId, key)])
  return state ?? (enabled ? { state: 'waiting' } : { state: 'off' })
}

/** One timeline the view wants read: its key and what the digest reads. */
export interface DigestTimeline {
  key: string
  messages: DigestMessage[]
}

const loading = new Set<string>()
/** The keys each tab's view wants read right now: a timeline that changed
 *  while its wait ran (a burst of messages) is not read in its old form. */
const current = new Map<string, Set<string>>()

/** The view's side of the digests: loads what is filed for the tab, then asks
 *  for each of the timelines given (the conversation's latest) that has no
 *  digest yet. */
export function useTimelineDigests(
  sessionId: string,
  timelines: readonly DigestTimeline[],
  launch: DigestLaunch
): void {
  const loaded = useDigestStore((s) => !!s.loaded[sessionId])
  useEffect(() => {
    if (loaded || loading.has(sessionId)) return
    const api = window.electronAPI?.exchangeDigestsOf
    loading.add(sessionId)
    void (api ? api(sessionId) : Promise.resolve({}))
      .catch(() => ({}))
      .then((filed) => useDigestStore.getState().file(sessionId, filed))
      .finally(() => loading.delete(sessionId))
  }, [sessionId, loaded])
  // The keys stand for the messages: a new message is a new key.
  const keys = timelines.map((t) => t.key).join(',')
  useEffect(() => {
    current.set(sessionId, new Set(timelines.map((t) => t.key)))
    if (!loaded) return
    for (const timeline of timelines) ask(sessionId, timeline, launch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, keys, loaded])
}

/** Ask for one timeline's digest, unless it is filed, asked for already, or
 *  given up on in this run of the app. */
function ask(sessionId: string, timeline: DigestTimeline, launch: DigestLaunch): void {
  const id = idOf(sessionId, timeline.key)
  const store = useDigestStore.getState()
  if (store.states[id]) return
  store.set(id, { state: 'waiting' })
  setTimeout(() => {
    if (!current.get(sessionId)?.has(timeline.key)) {
      // Moved on during the wait: forget it, the newer form is asked for.
      useDigestStore.setState((s) => ({ states: { ...s.states, [id]: undefined } }))
      return
    }
    const api = window.electronAPI?.exchangeDigest
    if (!api) {
      useDigestStore.getState().set(id, { state: 'failed' })
      return
    }
    useDigestStore.getState().set(id, { state: 'reading' })
    const giveUp = setTimeout(() => {
      if (useDigestStore.getState().states[id]?.state === 'reading')
        useDigestStore.getState().set(id, { state: 'failed' })
    }, DIGEST_GIVE_UP_MS)
    void api({ sessionId, key: timeline.key, launch, messages: timeline.messages })
      .catch((error: unknown): DigestResult => ({ ok: false, error: String(error) }))
      .then((result) => {
        clearTimeout(giveUp)
        useDigestStore
          .getState()
          .set(id, result.ok ? { state: 'done', result, fresh: true } : { state: 'failed' })
      })
  }, DIGEST_SETTLE_MS)
}
