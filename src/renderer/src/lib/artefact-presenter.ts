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
import { createPresenter, type Presenter } from './artefact-presenter-core'
import { useArtefactStore } from '../store/artefact-store'
import { useSessionStore } from '../store/session-store'

let presenter: Presenter | null = null

/** This window's presenter, over its own API and stores. */
export function windowPresenter(): Presenter {
  if (presenter) return presenter
  const api = window.electronAPI
  presenter = createPresenter({
    hold: (sessionId, holdId) => api.artefacts.hold(sessionId, holdId),
    release: (sessionId, holdId) => api.artefacts.release(sessionId, holdId),
    show: (sessionId, url, title) => api.presentation.show(sessionId, url, title),
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
/**
 * Follow the agents' asks, main's closes and the artefacts' changes;
 * idempotent. An ask is this window's to act on when the window holds the
 * session: every window hears it, one holds the tab.
 */
export function initPresenter(): void {
  if (started) return
  started = true
  const api = window.electronAPI
  const p = windowPresenter()
  api.artefacts.onPresentRequested((sessionId) => {
    if (!useSessionStore.getState().sessions.some((s) => s.id === sessionId)) return
    if (p.present(sessionId)) return
    // The change that opened it comes first on the same channel; should the
    // window not list it yet, it presents once it does, or never after ten seconds.
    const off = useArtefactStore.subscribe((state) => {
      if (!state.artefacts[sessionId]) return
      stop()
      p.present(sessionId)
    })
    const timer = setTimeout(() => off(), 10_000)
    const stop = (): void => {
      clearTimeout(timer)
      off()
    }
  })
  api.presentation.onClosed((sessionId) => p.closed(sessionId))
  api.artefacts.onPreviewExited((sessionId) => p.previewExited(sessionId))
  useArtefactStore.subscribe((state, prev) => {
    if (state.artefacts === prev.artefacts && state.version === prev.version) return
    for (const sessionId of p.sessions()) {
      const artefact = state.artefacts[sessionId] ?? null
      if (artefact !== (prev.artefacts[sessionId] ?? null)) p.artefactChanged(sessionId, artefact)
      p.versionChanged(sessionId)
    }
  })
}
