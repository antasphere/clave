/**
 * The rules of a window's presentation (PRDCT-4980), with no store and no
 * window API, so they are tested alone (`artefact-presenter.test.ts`): the
 * presentation's own hold, the address handed to main, and the moments it
 * lets go. `artefact-presenter.ts` runs them over the window's API and stores.
 */
import { startHoldLoop } from './artefact-hold'
import { withVersion } from './artefact-version'

/** A first hold refused this many times in a row (ten seconds apart) ends the try:
 *  long enough for a first install of Slideless, short of trying forever. */
export const PRESENT_REFUSALS_MAX = 6
/** A preview that dies more often than this in a minute ends the presentation. */
export const PRESENT_RESTARTS_MAX = 3

export interface PresenterDeps {
  hold: (
    sessionId: string,
    holdId?: string
  ) => Promise<{ url: string; holdId: string; ttlMs: number }>
  release: (sessionId: string, holdId: string) => Promise<void>
  show: (sessionId: string, url: string, title: string) => Promise<void>
  close: (sessionId: string) => Promise<void>
  /** The session's artefact as the window lists it. */
  artefact: (sessionId: string) => { openedAt: string; title: string } | undefined
  /** The version the session's panel shows for that open (`live`, `latest` or a number). */
  shown: (sessionId: string, openedAt: string) => string
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

export interface Presenter {
  /** Present the session's artefact, or bring its presentation forward. False when it has none. */
  present(sessionId: string): boolean
  isPresenting(sessionId: string): boolean
  /** Main says the presentation window closed. */
  closed(sessionId: string): void
  /** The server says the preview died under its holders. */
  previewExited(sessionId: string): void
  /** The session's artefact as the window lists it now (null: closed). */
  artefactChanged(sessionId: string, artefact: { openedAt: string } | null): void
  /** The version the panel shows may have changed. */
  versionChanged(sessionId: string): void
  sessions(): string[]
}

interface Running {
  readonly openedAt: string
  url?: string
  sentShown?: string
  refusals: number
  loop: { wake(): void; stop(): void }
}

/** The loop of an entry until its first call is made (synchronously, below). */
const NOT_STARTED = { wake: (): void => undefined, stop: (): void => undefined }

export function createPresenter(deps: PresenterDeps): Presenter {
  const now = deps.now ?? Date.now
  const running = new Map<string, Running>()
  const restarts = new Map<string, number[]>()

  const send = (sessionId: string, entry: Running): void => {
    if (entry.url === undefined) return
    const shown = deps.shown(sessionId, entry.openedAt)
    entry.sentShown = shown
    const title = deps.artefact(sessionId)?.title ?? 'Presentation'
    void deps.show(sessionId, withVersion(entry.url, shown), title).catch(() => {})
  }

  const drop = (sessionId: string): Running | undefined => {
    const entry = running.get(sessionId)
    if (!entry) return undefined
    running.delete(sessionId)
    entry.loop.stop()
    return entry
  }

  const start = (sessionId: string, openedAt: string): void => {
    const entry: Running = { openedAt, refusals: 0, loop: NOT_STARTED }
    running.set(sessionId, entry)
    entry.loop = startHoldLoop({
      hold: (holdId) => deps.hold(sessionId, holdId),
      release: (holdId) => deps.release(sessionId, holdId),
      onUrl: (url) => {
        if (running.get(sessionId) !== entry) return
        entry.url = url
        send(sessionId, entry)
      },
      onRefused: () => {
        if (running.get(sessionId) !== entry) return
        entry.refusals += 1
        if (entry.refusals < PRESENT_REFUSALS_MAX) return
        drop(sessionId)
        // A window already up (held before, refused since) goes with it.
        if (entry.url !== undefined) void deps.close(sessionId).catch(() => {})
      },
      ...(deps.setTimer && { setTimer: deps.setTimer }),
      ...(deps.clearTimer && { clearTimer: deps.clearTimer })
    })
  }

  const end = (sessionId: string): void => {
    if (drop(sessionId)) void deps.close(sessionId).catch(() => {})
  }

  return {
    present: (sessionId) => {
      const artefact = deps.artefact(sessionId)
      if (!artefact) return false
      const entry = running.get(sessionId)
      if (entry && entry.openedAt === artefact.openedAt) {
        // Already presented: brought forward (main focuses its window).
        send(sessionId, entry)
        return true
      }
      drop(sessionId)
      start(sessionId, artefact.openedAt)
      return true
    },
    isPresenting: (sessionId) => running.has(sessionId),
    closed: (sessionId) => {
      drop(sessionId)
    },
    previewExited: (sessionId) => {
      const entry = running.get(sessionId)
      if (!entry) return
      const at = now()
      const recent = (restarts.get(sessionId) ?? []).filter((t) => at - t < 60_000)
      if (recent.length >= PRESENT_RESTARTS_MAX) {
        restarts.delete(sessionId)
        end(sessionId)
        return
      }
      restarts.set(sessionId, [...recent, at])
      // Held again without the old id: the server answers the new preview's address.
      drop(sessionId)
      start(sessionId, entry.openedAt)
    },
    artefactChanged: (sessionId, artefact) => {
      const entry = running.get(sessionId)
      if (!entry) return
      if (artefact === null) return end(sessionId)
      if (artefact.openedAt === entry.openedAt) return
      // A new open by the agent: the presentation follows it.
      drop(sessionId)
      start(sessionId, artefact.openedAt)
    },
    versionChanged: (sessionId) => {
      const entry = running.get(sessionId)
      if (!entry || entry.url === undefined) return
      if (deps.shown(sessionId, entry.openedAt) !== entry.sentShown) send(sessionId, entry)
    },
    sessions: () => [...running.keys()]
  }
}
