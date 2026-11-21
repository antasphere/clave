import { useSessionStore } from '../store/session-store'
import { useUpdatesStore, voiceOf, type ReadingEnd } from '../store/updates-store'
import { announcementFor, nextToAnnounce, spokenName, updateName, type Update } from './updates'

/* The announcer of Folio's updates (PRDCT-4832), started once per window by
   AppShell. One voice at a time: while a reading is in progress, or a line is
   being said, nothing is announced; an update filed meanwhile waits silently
   (the chip counts it) and is said as soon as the voice is free. A reading an
   update started that is heard to its END, with updates still waiting, has
   the oldest one said again: the person may not be looking. An announcement
   opens the card as a banner, closed BANNER_MS later unless the pointer is
   over it or it was pinned. It also reports this window's status to main,
   which holds the system-wide key while an update waits or plays. */

/** How long an announced banner stays before it closes by itself. */
export const BANNER_MS = 8_000
/** How long a `busy` answer waits before the line is tried again, in case
 *  no change of the store says the voice is free. */
export const BUSY_RETRY_MS = 1_000

export interface UpdatesStatus {
  active: boolean
  playing: boolean
  oldestAt: number | null
}

/** The status main is told. Pure. */
export function updatesStatus(state: {
  updates: Update[]
  current: unknown | null
}): UpdatesStatus {
  return {
    active: state.updates.length > 0 || state.current !== null,
    playing: state.current !== null,
    oldestAt: state.updates[0]?.at ?? null
  }
}

/** Whether the waiting updates are said again after a reading ended (rule
 *  7): only a reading started from an update, heard to its end, with updates
 *  waiting. Pure. */
export function toAnnounceAgain(end: ReadingEnd | null, updates: Update[]): boolean {
  return !!end && end.how === 'heard' && end.fromUpdate && updates.length > 0
}

/** The one line for every update not yet announced, and which they are:
 *  their distinct names oldest first, in the oldest one's voice. Pure. */
export function lineFor(
  updates: Update[],
  nameOf: (sessionId: string) => string
): { ids: string[]; sessionId: string; text: string } | null {
  const waiting = updates.filter((u) => !u.announced)
  if (!waiting.length) return null
  const names: string[] = []
  for (const update of waiting) {
    const name = nameOf(update.sessionId)
    if (!names.includes(name)) names.push(name)
  }
  return {
    ids: waiting.map((u) => u.id),
    sessionId: waiting[0].sessionId,
    text: announcementFor(names, waiting.length)
  }
}

let pointerOver = false
let closeOnLeave = false

/** The card tells whether the pointer is over it: a banner never closes
 *  under the pointer, and closes once it leaves if its time is up. */
export function setCardHover(over: boolean): void {
  pointerOver = over
  if (over || !closeOnLeave) return
  closeOnLeave = false
  if (useUpdatesStore.getState().cardOpen === 'banner') useUpdatesStore.getState().closeCard()
}

export interface UpdatesVoiceDeps {
  /** The names of a tab, read live. */
  nameOf?: (sessionId: string) => { group: string | null; tab: string }
  /** Whether a tab still exists (a closed tab's update leaves). */
  exists?: (sessionId: string) => boolean
  report?: (status: UpdatesStatus) => void
  /** Subscribe to the tabs: every change may close one. */
  onSessions?: (listener: () => void) => () => void
}

const liveName = (sessionId: string): { group: string | null; tab: string } => {
  const { sessions, groups } = useSessionStore.getState()
  return updateName(sessionId, sessions, groups)
}

export function startUpdatesVoice(deps: UpdatesVoiceDeps = {}): () => void {
  const nameOf = deps.nameOf ?? liveName
  const exists =
    deps.exists ?? ((id: string) => useSessionStore.getState().sessions.some((s) => s.id === id))
  const report =
    deps.report ??
    ((status: UpdatesStatus) => {
      try {
        window.electronAPI?.updatesReport?.(status)
      } catch {
        /* a window without the bridge keeps its updates to itself */
      }
    })
  const onSessions =
    deps.onSessions ?? ((listener: () => void) => useSessionStore.subscribe(listener))
  const store = useUpdatesStore
  let stopped = false
  let saying = false
  let retry: ReturnType<typeof setTimeout> | null = null
  let banner: ReturnType<typeof setTimeout> | null = null
  let reported = ''

  const openBanner = (): void => {
    const { cardOpen, openCard } = store.getState()
    if (cardOpen === 'pinned') return
    if (cardOpen === null) openCard('banner')
    if (banner) clearTimeout(banner)
    closeOnLeave = false
    banner = setTimeout(() => {
      banner = null
      if (store.getState().cardOpen !== 'banner') return
      if (pointerOver) closeOnLeave = true
      else store.getState().closeCard()
    }, BANNER_MS)
  }

  const pump = (): void => {
    if (stopped || saying) return
    const state = store.getState()
    // A reading in progress, paused included, holds the voice: its end (the
    // store's change to `current: null`) pumps again, so nothing polls here.
    if (state.current !== null || !state.on) return
    const oldest = nextToAnnounce(state.updates)
    if (!oldest) return
    const voice = voiceOf(oldest.sessionId)
    if (!voice) {
      // Its pane is gone: so is the update.
      state.dismiss(oldest.id)
      return
    }
    const line = lineFor(state.updates, (id) => spokenName(nameOf(id)))
    if (!line) return
    saying = true
    void voice
      .say(line.text)
      .catch(() => 'failed' as const)
      .then((result) => {
        if (stopped) return
        if (result === 'busy' || result === 'cut') {
          saying = false
          // Not heard: said once the voice is free. A reading took it (the
          // store's `current` pumps at its end); else a short wait.
          if (result === 'busy' && store.getState().current === null) {
            if (retry) clearTimeout(retry)
            retry = setTimeout(() => {
              retry = null
              pump()
            }, BUSY_RETRY_MS)
          }
          return
        }
        // Said, or nothing could say it: either way not said again in a loop.
        // Every update of the line is marked before the next pump.
        const now = store.getState()
        const still = line.ids.filter((id) => now.updates.some((u) => u.id === id))
        for (const id of still) now.markAnnounced(id, true)
        saying = false
        if (still.length) openBanner()
        pump()
      })
  }

  const send = (): void => {
    const status = updatesStatus(store.getState())
    const key = JSON.stringify(status)
    if (key === reported) return
    reported = key
    report(status)
  }

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.lastEnd !== previous.lastEnd) {
      if (toAnnounceAgain(state.lastEnd, state.updates)) state.announceAgain()
    }
    send()
    pump()
  })
  const dropClosed = (): void => {
    const { updates, clearSession } = store.getState()
    for (const update of updates) if (!exists(update.sessionId)) clearSession(update.sessionId)
  }
  const unsubscribeSessions = onSessions(dropClosed)
  send()
  pump()
  return () => {
    stopped = true
    unsubscribe()
    unsubscribeSessions()
    if (retry) clearTimeout(retry)
    if (banner) clearTimeout(banner)
  }
}
