/**
 * The rules of a window's presentation (PRDCT-4980), with no store and no
 * window API, so they are tested alone (`artefact-presenter.test.ts`): the
 * presentation's own hold, the address handed to main, and the moments it
 * lets go. `artefact-presenter.ts` runs them over the window's API and stores.
 *
 * A presentation has an id of its own, kept across what moves it (the
 * preview restarted, a new open by the agent): main shows one presentation
 * per session, answers `false` to a window that is not the one presenting it
 * (another window of this Mac lists the same server session, or the person
 * closed this presentation), and says which presentation closed. A window
 * answered `false` lets go of its hold and does nothing else.
 */
import { startHoldLoop } from './artefact-hold'
import { withVersion } from './artefact-version'

/** A first hold refused this many times in a row (ten seconds apart) ends the try:
 *  long enough for a first install of Slideless, short of trying forever. */
export const PRESENT_REFUSALS_MAX = 6
/** A preview that dies more often than this in a minute ends the presentation. */
export const PRESENT_RESTARTS_MAX = 3
/** How long an agent's ask waits for its artefact to be listed by the window. */
export const PRESENT_ASK_WAIT_MS = 10_000

export interface PresenterDeps {
  hold: (
    sessionId: string,
    holdId?: string
  ) => Promise<{ url: string; holdId: string; ttlMs: number }>
  release: (sessionId: string, holdId: string) => Promise<void>
  /** Show the deck at `url` in the session's presentation window. False: this window
   *  is not the one presenting it (another one is, or the person closed it). */
  show: (sessionId: string, url: string, title: string, presentationId: string) => Promise<boolean>
  close: (sessionId: string) => Promise<void>
  /** The session's artefact as the window lists it. */
  artefact: (sessionId: string) => { openedAt: string; title: string } | undefined
  /** The version the session's panel shows for that open (`live`, `latest` or a number). */
  shown: (sessionId: string, openedAt: string) => string
  newId?: () => string
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

export interface Presenter {
  /** Present the session's artefact, or bring its presentation forward. False when it has none. */
  present(sessionId: string): boolean
  isPresenting(sessionId: string): boolean
  /** Main says this presentation's window closed (Escape, or by hand). */
  closed(sessionId: string, presentationId: string): void
  /** The server says the preview died under its holders. */
  previewExited(sessionId: string): void
  /** The server says the session's artefact changed: closed (null), or opened anew. */
  artefactChanged(sessionId: string, artefact: { openedAt: string } | null): void
  /** The window lists the session's artefact so: another open follows it; a session
   *  missing from the list says nothing (a server that did not answer lists none). */
  artefactListed(sessionId: string, artefact: { openedAt: string } | undefined): void
  /** The version the panel shows may have changed. */
  versionChanged(sessionId: string): void
  sessions(): string[]
}

interface Running {
  readonly presentationId: string
  readonly openedAt: string
  url?: string
  sentShown?: string
  /** A show was sent for this presentation (this entry or one it replaced): a window may be up. */
  sent: boolean
  refusals: number
  loop: { wake(): void; stop(): void }
}

/** The loop of an entry until its first call is made (synchronously, below). */
const NOT_STARTED = { wake: (): void => undefined, stop: (): void => undefined }

const randomId = (): string => globalThis.crypto.randomUUID()

export function createPresenter(deps: PresenterDeps): Presenter {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomId
  const running = new Map<string, Running>()
  const restarts = new Map<string, number[]>()

  const drop = (sessionId: string): Running | undefined => {
    const entry = running.get(sessionId)
    if (!entry) return undefined
    running.delete(sessionId)
    entry.loop.stop()
    return entry
  }

  /** Let go, and close the window a show may have put up (main takes them in order). */
  const end = (sessionId: string): void => {
    const entry = drop(sessionId)
    if (entry?.sent) void deps.close(sessionId).catch(() => {})
  }

  const send = (sessionId: string, entry: Running): void => {
    if (entry.url === undefined) return
    const shown = deps.shown(sessionId, entry.openedAt)
    entry.sentShown = shown
    entry.sent = true
    const title = deps.artefact(sessionId)?.title ?? 'Presentation'
    const current = (): boolean => running.get(sessionId) === entry
    deps.show(sessionId, withVersion(entry.url, shown), title, entry.presentationId).then(
      (taken) => {
        if (!taken && current()) drop(sessionId)
      },
      () => {
        if (current()) drop(sessionId)
      }
    )
  }

  const start = (
    sessionId: string,
    openedAt: string,
    presentationId: string,
    sent: boolean
  ): void => {
    const entry: Running = { presentationId, openedAt, sent, refusals: 0, loop: NOT_STARTED }
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
        if (entry.refusals >= PRESENT_REFUSALS_MAX) end(sessionId)
      },
      ...(deps.setTimer && { setTimer: deps.setTimer }),
      ...(deps.clearTimer && { clearTimer: deps.clearTimer })
    })
  }

  /** The same presentation, on another open or a new preview: its id and window kept. */
  const restart = (sessionId: string, openedAt: string): void => {
    const entry = drop(sessionId)
    if (entry) start(sessionId, openedAt, entry.presentationId, entry.sent)
  }

  const follow = (sessionId: string, artefact: { openedAt: string }): void => {
    const entry = running.get(sessionId)
    if (entry && artefact.openedAt !== entry.openedAt) restart(sessionId, artefact.openedAt)
  }

  return {
    present: (sessionId) => {
      const artefact = deps.artefact(sessionId)
      if (!artefact) return false
      const entry = running.get(sessionId)
      if (!entry) start(sessionId, artefact.openedAt, newId(), false)
      // Already presented: brought forward (main focuses its window).
      else if (entry.openedAt === artefact.openedAt) send(sessionId, entry)
      else restart(sessionId, artefact.openedAt)
      return true
    },
    isPresenting: (sessionId) => running.has(sessionId),
    closed: (sessionId, presentationId) => {
      if (running.get(sessionId)?.presentationId === presentationId) drop(sessionId)
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
      restart(sessionId, entry.openedAt)
    },
    artefactChanged: (sessionId, artefact) => {
      if (!running.has(sessionId)) return
      if (artefact === null) end(sessionId)
      else follow(sessionId, artefact)
    },
    artefactListed: (sessionId, artefact) => {
      if (artefact) follow(sessionId, artefact)
    },
    versionChanged: (sessionId) => {
      const entry = running.get(sessionId)
      if (!entry || entry.url === undefined) return
      if (deps.shown(sessionId, entry.openedAt) !== entry.sentShown) send(sessionId, entry)
    },
    sessions: () => [...running.keys()]
  }
}

/** What the window offers the presenter: who it shows, and what it hears. */
export interface PresenterWiring {
  presenter: Presenter
  /** Whether this window lists the session: an agent's ask is for the windows that do. */
  shows: (sessionId: string) => boolean
  /** The session's artefact as the window lists it now. */
  listed: (sessionId: string) => { openedAt: string } | undefined
  onPresentRequested: (callback: (sessionId: string) => void) => () => void
  onClosed: (
    callback: (closed: { sessionId: string; presentationId: string }) => void
  ) => () => void
  onPreviewExited: (callback: (sessionId: string) => void) => () => void
  onChanged: (
    callback: (change: { sessionId: string; artefact: { openedAt: string } | null }) => void
  ) => () => void
  /** The window's list of artefacts, or a version chosen in a panel, changed. */
  onListChanged: (callback: () => void) => () => void
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

/**
 * Follow the agents' asks, main's closes, the server's changes and the
 * window's list; answers the unsubscribe. An ask whose artefact the window
 * does not list yet (the change that opened it comes first on the same
 * channel, so this is the exception) presents once it is listed, or never
 * after PRESENT_ASK_WAIT_MS.
 */
export function wirePresenter(w: PresenterWiring): () => void {
  const setTimer = w.setTimer ?? setTimeout
  const clearTimer = w.clearTimer ?? clearTimeout
  const waiting = new Map<string, ReturnType<typeof setTimeout>>()
  const offs = [
    w.onPresentRequested((sessionId) => {
      if (!w.shows(sessionId) || w.presenter.present(sessionId)) return
      const before = waiting.get(sessionId)
      if (before !== undefined) clearTimer(before)
      waiting.set(
        sessionId,
        setTimer(() => waiting.delete(sessionId), PRESENT_ASK_WAIT_MS)
      )
    }),
    w.onClosed(({ sessionId, presentationId }) => w.presenter.closed(sessionId, presentationId)),
    w.onPreviewExited((sessionId) => w.presenter.previewExited(sessionId)),
    w.onChanged(({ sessionId, artefact }) => w.presenter.artefactChanged(sessionId, artefact)),
    w.onListChanged(() => {
      for (const [sessionId, timer] of [...waiting]) {
        if (!w.listed(sessionId)) continue
        clearTimer(timer)
        waiting.delete(sessionId)
        w.presenter.present(sessionId)
      }
      for (const sessionId of w.presenter.sessions()) {
        w.presenter.artefactListed(sessionId, w.listed(sessionId))
        w.presenter.versionChanged(sessionId)
      }
    })
  ]
  return () => {
    for (const off of offs) off()
    for (const timer of waiting.values()) clearTimer(timer)
    waiting.clear()
  }
}
