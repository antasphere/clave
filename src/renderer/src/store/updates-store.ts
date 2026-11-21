import { create } from 'zustand'
import type { Reading } from '../../../../plugins/chat-view/src/lab/read-aloud'
import { fileUpdate, withoutSession, withoutUpdate, type Update } from '../lib/updates'

/* Folio's play mode and its updates (PRDCT-4832). `on` is the speaker switch:
   ONE choice for the whole app on this Mac, live in every Folio pane at once,
   kept in `localStorage['clave.folio.read-aloud']` (`on`/`off`). `updates` are
   the finished answers filed while their pane was off the page (one per tab,
   the newest, `lib/updates.ts`), in memory only. `current` is the reading in
   progress in this window, published by the pane that reads it. The chip,
   the card and the key drive the reading through the commands below, which
   find the pane's voice in a module-level registry (never zustand state: the
   controls are functions a pane owns). */

export const PLAY_MODE_KEY = 'clave.folio.read-aloud'

/** How a line went: heard to its end, refused (the voice is busy), nothing
 *  could speak it, or a reading took the voice from it part way. */
export type SayResult = 'said' | 'busy' | 'failed' | 'cut'

/** A Folio pane's voice, as the commands drive it. */
export interface VoiceControls {
  read: (pageKey: string, markdown: string) => void
  pause: () => void
  resume: () => void
  stop: () => void
  seekBlock: (n: number) => void
  say: (text: string) => Promise<SayResult>
}

/** The reading in progress in this window. */
export interface CurrentReading {
  sessionId: string
  pageKey: string
  title: string
  reading: Reading
  onScreen: boolean
  fromUpdate: boolean
}

/** How the last reading ended: by itself (`heard`) or by a Stop, and whether
 *  an update started it. The announcer reads it (rule 7). */
export interface ReadingEnd {
  sessionId: string
  pageKey: string
  how: 'heard' | 'stopped'
  fromUpdate: boolean
  at: number
}

export type CardOpen = 'banner' | 'pinned' | null

interface UpdatesState {
  on: boolean
  updates: Update[]
  current: CurrentReading | null
  cardOpen: CardOpen
  lastEnd: ReadingEnd | null
  setOn: (on: boolean) => void
  file: (next: Omit<Update, 'id' | 'announced'>) => void
  dismiss: (id: string) => void
  clearSession: (sessionId: string) => void
  markAnnounced: (id: string, announced: boolean) => void
  /** Every waiting update to be said again (rule 7). */
  announceAgain: () => void
  /** A pane publishes its reading (null once it ends). `fromUpdate` and the
   *  title of a reading the store's `play` started are the store's own. */
  publish: (
    sessionId: string,
    current: (Omit<CurrentReading, 'fromUpdate' | 'title'> & { title: string | null }) | null
  ) => void
  /** A pane's reading ended: by itself or by a Stop. */
  ended: (sessionId: string, pageKey: string, how: 'heard' | 'stopped') => void
  openCard: (mode: 'banner' | 'pinned') => void
  closeCard: () => void
  /** Pause or resume the current reading; else play the oldest update.
   *  Whether it did anything. */
  toggle: () => boolean
  play: (id: string) => boolean
  stop: () => void
  /** Move the current reading to tick `tick` of its bar. */
  seek: (tick: number) => void
}

function readPlayMode(): boolean {
  try {
    return localStorage.getItem(PLAY_MODE_KEY) === 'on'
  } catch {
    return false
  }
}

const voices = new Map<string, VoiceControls>()
/** The readings `play` started and their pane has not published yet, by tab:
 *  the page and the title the update carried. */
const played = new Map<string, { pageKey: string; title: string }>()

/** A pane's voice, while it is the tab's chosen view. The returned function
 *  takes it away, and only it. */
export function registerVoice(sessionId: string, controls: VoiceControls): () => void {
  voices.set(sessionId, controls)
  return () => {
    if (voices.get(sessionId) === controls) voices.delete(sessionId)
  }
}

/** The voice of a tab's pane, if it is there. */
export function voiceOf(sessionId: string): VoiceControls | undefined {
  return voices.get(sessionId)
}

export const useUpdatesStore = create<UpdatesState>((set, get) => ({
  on: readPlayMode(),
  updates: [],
  current: null,
  cardOpen: null,
  lastEnd: null,
  setOn: (on) => {
    set({ on })
    try {
      localStorage.setItem(PLAY_MODE_KEY, on ? 'on' : 'off')
    } catch {
      /* a private store: the choice lasts the window's life */
    }
  },
  file: (next) => set((s) => ({ updates: fileUpdate(s.updates, next) })),
  dismiss: (id) =>
    set((s) => {
      const updates = withoutUpdate(s.updates, id)
      return updates === s.updates ? s : { updates }
    }),
  clearSession: (sessionId) =>
    set((s) => {
      const updates = withoutSession(s.updates, sessionId)
      return updates === s.updates ? s : { updates }
    }),
  markAnnounced: (id, announced) =>
    set((s) => {
      if (!s.updates.some((u) => u.id === id && u.announced !== announced)) return s
      return { updates: s.updates.map((u) => (u.id === id ? { ...u, announced } : u)) }
    }),
  announceAgain: () =>
    set((s) =>
      s.updates.some((u) => u.announced)
        ? { updates: s.updates.map((u) => (u.announced ? { ...u, announced: false } : u)) }
        : s
    ),
  publish: (sessionId, current) => {
    const now = get().current
    if (!current) {
      if (now?.sessionId === sessionId) set({ current: null })
      return
    }
    const started = played.get(sessionId)
    const fromUpdate =
      started?.pageKey === current.pageKey ||
      (now?.sessionId === sessionId && now.pageKey === current.pageKey && now.fromUpdate)
    const title =
      current.title ??
      (started?.pageKey === current.pageKey ? started.title : null) ??
      (now?.sessionId === sessionId && now.pageKey === current.pageKey ? now.title : '')
    if (started?.pageKey === current.pageKey) played.delete(sessionId)
    const next: CurrentReading = { ...current, title, fromUpdate }
    if (
      now &&
      now.sessionId === next.sessionId &&
      now.pageKey === next.pageKey &&
      now.reading === next.reading &&
      now.onScreen === next.onScreen &&
      now.title === next.title &&
      now.fromUpdate === next.fromUpdate
    )
      return
    set({ current: next })
  },
  ended: (sessionId, pageKey, how) => {
    const now = get().current
    const fromUpdate =
      (now?.sessionId === sessionId && now.pageKey === pageKey && now.fromUpdate) ||
      played.get(sessionId)?.pageKey === pageKey
    if (played.get(sessionId)?.pageKey === pageKey) played.delete(sessionId)
    set({
      current: now?.sessionId === sessionId ? null : now,
      lastEnd: { sessionId, pageKey, how, fromUpdate, at: Date.now() }
    })
  },
  openCard: (mode) => set({ cardOpen: mode }),
  closeCard: () => set({ cardOpen: null }),
  toggle: () => {
    const { current, updates } = get()
    if (current) {
      const voice = voices.get(current.sessionId)
      if (!voice) return false
      if (current.reading.state === 'paused') voice.resume()
      else if (current.reading.state === 'playing') voice.pause()
      // Preparing: nothing to pause yet, and nothing else is started.
      return true
    }
    const oldest = updates[0]
    return oldest ? get().play(oldest.id) : false
  },
  play: (id) => {
    const update = get().updates.find((u) => u.id === id)
    if (!update) return false
    const voice = voices.get(update.sessionId)
    // The pane is gone: so is its update.
    set((s) => ({ updates: withoutUpdate(s.updates, id) }))
    if (!voice) return false
    played.set(update.sessionId, { pageKey: update.pageKey, title: update.title })
    voice.read(update.pageKey, update.markdown)
    return true
  },
  stop: () => {
    const { current } = get()
    if (current) voices.get(current.sessionId)?.stop()
  },
  seek: (tick) => {
    const { current } = get()
    if (!current) return
    const block = current.reading.ticks[tick]
    if (block !== undefined) voices.get(current.sessionId)?.seekBlock(block)
  }
}))

/** Forget everything but the switch: a test's clean slate. */
export function resetUpdates(): void {
  voices.clear()
  played.clear()
  useUpdatesStore.setState({
    on: readPlayMode(),
    updates: [],
    current: null,
    cardOpen: null,
    lastEnd: null
  })
}
