/**
 * The window's side of a presentation (PRDCT-4980): a session's deck alone,
 * full screen, in a window main makes (`src/main/presentation/`). This window
 * holds the preview the way its panel does, with a hold of its own, so hiding
 * the panel or looking at another tab keeps the deck up; it hands main the
 * address, follows the version the panel shows and a new open by the agent,
 * holds again when the preview dies, and lets go when the presentation
 * window closes (Escape, or by hand) or the artefact is closed.
 *
 * The agent asks with `clave_open_artefact`'s `present`; the window that
 * holds the session is the one that presents (`initPresenter`). The person
 * asks with Present in the artefact's menu.
 */
import { shownFor } from './artefact-version'
import { createPresenter, wirePresenter, type Presenter } from './artefact-presenter-core'
import { useArtefactStore } from '../store/artefact-store'
import { useSessionStore } from '../store/session-store'

let presenter: Presenter | null = null

/** This window's presenter, over its own API and stores. */
export function windowPresenter(): Presenter {
  if (presenter) return presenter
  const api = window.electronAPI
  presenter = createPresenter({
    hold: (sessionId, holdId, target) => api.artefacts.hold(sessionId, holdId, target),
    release: (sessionId, holdId) => api.artefacts.release(sessionId, holdId),
    show: (sessionId, url, title, presentationId) =>
      api.presentation.show(sessionId, url, title, presentationId),
    close: (sessionId) => api.presentation.close(sessionId),
    artefact: (sessionId) => useArtefactStore.getState().artefacts[sessionId],
    shown: (sessionId, openedAt) =>
      shownFor(useArtefactStore.getState().version[sessionId], openedAt)
  })
  return presenter
}

/** Present the session's artefact from this window (the artefact menu's Present). */
export const presentArtefact = (sessionId: string): boolean => windowPresenter().present(sessionId)

let started = false
/** Follow the agents' asks, main's closes and the artefacts' changes; idempotent. */
export function initPresenter(): void {
  if (started) return
  started = true
  const api = window.electronAPI
  // The end-to-end specs read which presentations a window runs; a user's app has no handle.
  if (window.__claveTestMode)
    (window as { __clavePresenterForTests?: Presenter }).__clavePresenterForTests =
      windowPresenter()
  wirePresenter({
    presenter: windowPresenter(),
    // Every window that lists the session hears the ask (a server's sessions are
    // listed by every window showing that server): main keeps one presentation.
    shows: (sessionId) => useSessionStore.getState().sessions.some((s) => s.id === sessionId),
    listed: (sessionId) => useArtefactStore.getState().artefacts[sessionId],
    onPresentRequested: (callback) => api.artefacts.onPresentRequested(callback),
    onClosed: (callback) => api.presentation.onClosed(callback),
    onPreviewExited: (callback) => api.artefacts.onPreviewExited(callback),
    onChanged: (callback) => api.artefacts.onChanged(callback),
    onListChanged: (callback) =>
      useArtefactStore.subscribe((state, prev) => {
        if (state.artefacts !== prev.artefacts || state.version !== prev.version) callback()
      })
  })
}
