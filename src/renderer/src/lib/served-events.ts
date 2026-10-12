/**
 * What the window does when the SERVER did something to one of its tabs
 * through an agent tool (wave 4, PRDCT-3377): the facts arrive on the push
 * channel and the store follows, writing nothing back. A rename lands as
 * the record keeps it; a page on a tab's row comes with the session serving
 * it, which joins the store as the hidden half of the tab (and the one it
 * replaces leaves); a message typed into a tab marks its row as a sibling's
 * message does; a tab about to restart on another account is marked so its
 * exit is not announced, and the restart remounts its pane on the new
 * process; a pinned group the server launched is linked to its pin.
 */
import { useSessionStore } from '../store/session-store'
import { usePinnedStore } from '../store/pinned-store'
import { useWorkspaceStore } from '../store/workspace-store'
import { adoptServerStartedTerminals } from './adopt-record'

let started = false

export function initServedToolsEvents(): void {
  if (started) return
  started = true
  const api = window.electronAPI
  if (!api) return
  api.onSessionRenamed?.(({ id, name }) => {
    useSessionStore.getState().applyServedRename(id, name)
  })
  api.onSessionPageChanged?.(({ id, page, servingSessionId }) => {
    const store = useSessionStore.getState()
    if (!store.sessions.some((s) => s.id === id)) return
    store.applyServedPage(
      id,
      page
        ? {
            url: page.url,
            title: page.title,
            command: page.command,
            cwd: page.cwd,
            serverSessionId: servingSessionId
          }
        : null
    )
    // The serving session is hidden: it joins the store from its record,
    // never a row, as a quick-launch terminal the server started does.
    if (servingSessionId && !store.sessions.some((s) => s.id === servingSessionId)) {
      void adoptServerStartedTerminals([servingSessionId])
    }
  })
  api.onSessionTyped?.(({ id, from }) => {
    const store = useSessionStore.getState()
    if (!store.sessions.some((s) => s.id === id)) return
    store.setSessionInjectedFrom(id, from ?? 'another tab')
    if (!store.selectedSessionIds.includes(id)) store.setSessionUnseenActivity(id, true)
  })
  api.onSessionRestarting?.(({ id }) => {
    const store = useSessionStore.getState()
    if (store.sessions.some((s) => s.id === id)) store.setSessionRestarting(id, true)
  })
  api.onSessionRestarted?.(({ id, account }) => {
    const store = useSessionStore.getState()
    const session = store.sessions.find((s) => s.id === id)
    if (!session) return
    store.applySessionRestart(id, {
      ...(account.codexAccountId !== undefined
        ? { codexAccountId: account.codexAccountId, codexAccountLabel: account.codexAccountLabel }
        : {}),
      ...(account.claudeProfileId !== undefined
        ? {
            claudeProfileId: account.claudeProfileId,
            claudeProfileLabel: account.claudeProfileLabel,
            claudeConfigDir: undefined
          }
        : {})
    })
    // The new process starts when its pane measures itself, which a pane
    // off screen never does: kicked at a plain size, as the window's own
    // switch does; a pane on screen refits it at once.
    const current = useSessionStore.getState()
    const onScreen = current.activeView === 'terminals' && current.selectedSessionIds.includes(id)
    if (!onScreen && session.sessionType === 'local') api.startSession(id, 120, 30)
  })
  api.onPinnedGroupLaunched?.(({ pinnedId, groupId, windowKey }) => {
    if (useWorkspaceStore.getState().windowKey !== windowKey) return
    const pins = usePinnedStore.getState()
    if (!pins.pinnedGroups.some((p) => p.id === pinnedId)) return
    pins.setActiveGroupId(pinnedId, groupId)
    pins.setVisible(pinnedId, true)
  })
}
