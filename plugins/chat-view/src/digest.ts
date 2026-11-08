import { useEffect } from 'react'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type {
  DigestDone,
  DigestLaunch,
  DigestMessage,
  DigestResult
} from '../../../src/shared/exchange-digest'
import type { WorkDigestDone, WorkDigestResult } from '../../../src/shared/work-digest'

/**
 * The one-shot digests on the view's side. Main reads them and files them by
 * the tab's session id (src/main/exchange-digest-store.ts), so each is read
 * once: a remount, a restart and both views of the tab find it there. Two
 * families share one mechanism here, each with a store of its own: the
 * EXCHANGE digest (what the reader needs from a timeline of messages other
 * tabs sent) and the WORK digest (the title of a card of the agent's working
 * notes, PRDCT-4212). For each, one store says where a digest stands, by
 * session and key:
 *
 *  - the view asks, not the card on screen (`useTimelineDigests`,
 *    `useStretchDigests`): the rows are virtualised, and a digest must not
 *    wait for its card to be scrolled to, nor start again when the card is
 *    scrolled away and back;
 *  - opening a tab loads every digest filed for it, at once;
 *  - a digest not filed yet is asked for once its card has held still for
 *    DIGEST_SETTLE_MS, and goes on to the end whatever the reader does, so it
 *    is filed even if they left;
 *  - a card stops saying it reads after DIGEST_GIVE_UP_MS.
 */

/** How long a card must hold still before its digest is asked for: a burst
 *  of messages is read once, at its end, not once per message. */
export const DIGEST_SETTLE_MS = 2500
/** How long a digest may be read before the card stops saying so. */
export const DIGEST_GIVE_UP_MS = 90_000

export type DigestStateOf<Done> =
  /** Not read, and not to be: an older card (`Exchanges.recent`). */
  | { state: 'off' }
  | { state: 'waiting' }
  | { state: 'reading' }
  /** `fresh`: read while the reader was here, rather than found filed. */
  | { state: 'done'; result: Done; fresh?: boolean }
  | { state: 'failed' }
export type DigestState = DigestStateOf<DigestDone>
export type WorkDigestState = DigestStateOf<WorkDigestDone>

interface DigestStore<Done> {
  states: Record<string, DigestStateOf<Done> | undefined>
  loaded: Record<string, true | undefined>
  set: (id: string, state: DigestStateOf<Done>) => void
  file: (sessionId: string, filed: Record<string, Done>) => void
}

/** One card the view wants read: its key and what the digest reads. */
export interface DigestItem<Payload> {
  key: string
  payload: Payload
}

const idOf = (sessionId: string, key: string): string => `${sessionId}|${key}`

/** One family of digests: how to load what is filed for a tab, and how to
 *  ask for one. The `useDigests` hook is the view's, `useState` the card's. */
function createDigests<Payload, Done>(api: {
  filed: (sessionId: string) => Promise<Record<string, Done>> | undefined
  read: (
    sessionId: string,
    key: string,
    launch: DigestLaunch,
    payload: Payload
  ) => Promise<{ ok: true } | { ok: false; error: string }> | undefined
}): {
  useStore: UseBoundStore<StoreApi<DigestStore<Done>>>
  useState: (sessionId: string, key: string, enabled: boolean) => DigestStateOf<Done>
  useDigests: (
    sessionId: string,
    items: readonly DigestItem<Payload>[],
    launch: DigestLaunch
  ) => void
} {
  const useStore = create<DigestStore<Done>>((set) => ({
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
  const loading = new Set<string>()
  /** The keys each tab's view wants read right now: a card that changed
   *  while its wait ran (a burst of messages) is not read in its old form. */
  const current = new Map<string, Set<string>>()

  /** Ask for one card's digest, unless it is filed, asked for already, or
   *  given up on in this run of the app. */
  const ask = (sessionId: string, item: DigestItem<Payload>, launch: DigestLaunch): void => {
    const id = idOf(sessionId, item.key)
    const store = useStore.getState()
    if (store.states[id]) return
    store.set(id, { state: 'waiting' })
    setTimeout(() => {
      if (!current.get(sessionId)?.has(item.key)) {
        // Moved on during the wait: forget it, the newer form is asked for.
        useStore.setState((s) => ({ states: { ...s.states, [id]: undefined } }))
        return
      }
      const call = api.read(sessionId, item.key, launch, item.payload)
      if (!call) {
        useStore.getState().set(id, { state: 'failed' })
        return
      }
      useStore.getState().set(id, { state: 'reading' })
      const giveUp = setTimeout(() => {
        if (useStore.getState().states[id]?.state === 'reading')
          useStore.getState().set(id, { state: 'failed' })
      }, DIGEST_GIVE_UP_MS)
      void call
        .catch((error: unknown) => ({ ok: false as const, error: String(error) }))
        .then((result) => {
          clearTimeout(giveUp)
          useStore
            .getState()
            .set(
              id,
              result.ok
                ? { state: 'done', result: result as unknown as Done, fresh: true }
                : { state: 'failed' }
            )
        })
    }, DIGEST_SETTLE_MS)
  }

  return {
    useStore,
    useState: (sessionId, key, enabled) => {
      const state = useStore((s) => s.states[idOf(sessionId, key)])
      return state ?? (enabled ? { state: 'waiting' } : { state: 'off' })
    },
    useDigests: (sessionId, items, launch) => {
      const loaded = useStore((s) => !!s.loaded[sessionId])
      useEffect(() => {
        if (loaded || loading.has(sessionId)) return
        loading.add(sessionId)
        void (api.filed(sessionId) ?? Promise.resolve({} as Record<string, Done>))
          .catch(() => ({}) as Record<string, Done>)
          .then((filed) => useStore.getState().file(sessionId, filed))
          .finally(() => loading.delete(sessionId))
      }, [sessionId, loaded])
      // The keys stand for the payloads: a new message is a new key.
      const keys = items.map((item) => item.key).join(',')
      useEffect(() => {
        current.set(sessionId, new Set(items.map((item) => item.key)))
        if (!loaded) return
        for (const item of items) ask(sessionId, item, launch)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId, keys, loaded])
    }
  }
}

/* The exchange digests: a timeline's messages. */

/** One timeline the view wants read: its key and what the digest reads. */
export interface DigestTimeline {
  key: string
  messages: DigestMessage[]
}

const exchanges = createDigests<DigestMessage[], DigestDone>({
  filed: (sessionId) => window.electronAPI?.exchangeDigestsOf?.(sessionId),
  read: (sessionId, key, launch, messages): Promise<DigestResult> | undefined =>
    window.electronAPI?.exchangeDigest?.({ sessionId, key, launch, messages })
})

export const useDigestStore = exchanges.useStore

/** Where a timeline's digest stands, for its head. */
export const useDigestState = exchanges.useState

/** The view's side of the exchange digests: loads what is filed for the tab,
 *  then asks for each of the timelines given (the conversation's latest) that
 *  has no digest yet. */
export function useTimelineDigests(
  sessionId: string,
  timelines: readonly DigestTimeline[],
  launch: DigestLaunch
): void {
  exchanges.useDigests(
    sessionId,
    timelines.map((t) => ({ key: t.key, payload: t.messages })),
    launch
  )
}

/* The work digests: a stretch's notes (`stretches.ts`, `WorkStretch.tsx`). */

/** One stretch the view wants titled: its key, its notes, its tool count. */
export interface DigestStretch {
  key: string
  notes: string[]
  tools: number
}

const stretches = createDigests<{ notes: string[]; tools: number }, WorkDigestDone>({
  filed: (sessionId) => window.electronAPI?.workDigestsOf?.(sessionId),
  read: (sessionId, key, launch, payload): Promise<WorkDigestResult> | undefined =>
    window.electronAPI?.workDigest?.({ sessionId, key, launch, ...payload })
})

export const useWorkDigestStore = stretches.useStore

/** Where a stretch's digest stands, for its card's face. */
export const useWorkDigestState = stretches.useState

/** The view's side of the work digests: the conversation's latest stretches
 *  are titled whether or not their cards are on screen. */
export function useStretchDigests(
  sessionId: string,
  items: readonly DigestStretch[],
  launch: DigestLaunch
): void {
  stretches.useDigests(
    sessionId,
    items.map((s) => ({ key: s.key, payload: { notes: s.notes, tools: s.tools } })),
    launch
  )
}
