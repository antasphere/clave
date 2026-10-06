import { app, BrowserWindow } from 'electron'
import { SidebarLayouts, fileSidebarStorage, type SidebarHost } from '@clave/server/sidebar-layouts'
import type { MoveRefusal, MoveResult, WindowLayout } from '@clave/contract/sidebar'
import { windowRegistry } from './window-registry'
import { windowState } from './window-state'
import { ptyManager } from './pty-manager'

/**
 * The sidebar domain as the shell runs it (PRDCT-3241). The truth of every
 * window's sidebar (its groups, their terminals and views, the top-level
 * order) is ONE `SidebarLayouts` instance in this process, keyed by window
 * key, persisted to the same per-window files as before through the
 * server package's own storage. The in-process server is handed this very
 * instance (`src/main/server/clave-server.ts`), so a command that arrives
 * over its API and a call from this process change the same object; the
 * shell is the instance's HOST: it alone knows which windows exist, which is
 * the primary, and how to detach a live session from one window and hand it
 * to another.
 *
 * Two transports reach it from a window and both end here. When the server
 * runs inside the app, the preload routes the sidebar methods through the
 * client and the changes come back over the push channel. When the app is
 * attached to a server running on its own, that server has no windows to
 * host and no access to this process, so the windows keep their sidebar
 * on IPC with this instance (`sidebar:transport` answers which, and the
 * preload asks until it knows). Either way `onChange` is mirrored to the
 * window the layout belongs to over IPC, which is what the IPC transport
 * listens on and what the push transport ignores.
 *
 * The server package's class carries no Effect import, so building it here
 * at boot costs nothing (`src/main/server/lazy-load.test.ts`).
 */

/** What a target window receives to take in sessions (and, on a window
 *  close or a group move, the groups that come with them). */
export interface RehomePayload {
  sessionIds: string[]
  layout: WindowLayout | null
  /** A deliberate move (the user's, an agent's) takes focus in its new
   *  window like a spawn does; a window-close hand-over stays neutral. */
  focus: boolean
}

const refusal = (sessionId: string, target: BrowserWindow | null): MoveRefusal | null => {
  const session = ptyManager.getSession(sessionId)
  if (!session) return { sessionId, reason: 'not-live' }
  const host = windowRegistry.getWindowForSession(sessionId)
  if (target && host && host.id === target.id) return { sessionId, reason: 'same-window' }
  if (!session.tmuxName) return { sessionId, reason: 'not-tmux' }
  return null
}

/**
 * Move live sessions to the window `targetWindowKey`: for each tmux-backed
 * session hosted elsewhere, tell its old host to drop the tab (a MOVE, not
 * a death: the tab goes without touching the pty), detach the pty
 * (`kill(id, false)` keeps the tmux session and its record alive), unbind,
 * then hand the ids to the target, whose renderer re-adopts them (the same
 * tmux session, scrollback intact, the id preserved so MCP addressing and
 * exchange capture survive). A plain-pty session is refused: its process
 * would die with the detach. This is the rehome hook: the terminal layer
 * (lane B) calls it when a session must change windows, and the sidebar
 * domain calls it for every move it decides.
 */
export function rehomeSessions(
  sessionIds: ReadonlyArray<string>,
  targetWindowKey: string,
  options: { layout: WindowLayout | null; focus: boolean }
): MoveResult {
  const target = windowRegistry.getWindowByKey(targetWindowKey)
  const result: MoveResult = { moved: [], refused: [] }
  if (!target) {
    return { moved: [], refused: sessionIds.map((id) => ({ sessionId: id, reason: 'not-live' })) }
  }
  const moved: string[] = []
  const refused: MoveRefusal[] = []
  for (const id of sessionIds) {
    const why = refusal(id, target)
    if (why) {
      refused.push(why)
      continue
    }
    const oldHost = windowRegistry.getWindowForSession(id)
    // Tell the old host to drop the tab FIRST, so its terminal unmounts
    // before the detach's pty:exit could paint "[Session ended]" on it.
    if (oldHost && !oldHost.isDestroyed())
      oldHost.webContents.send('session:removed-for-rehome', id)
    ptyManager.kill(id, false) // detach: tmux session and record survive
    windowRegistry.unbindSession(id)
    moved.push(id)
  }
  if (moved.length > 0 || (options.layout && options.layout.groups.length > 0)) {
    const payload: RehomePayload = {
      sessionIds: moved,
      layout: options.layout,
      focus: options.focus
    }
    target.webContents.send('session:rehome', payload)
  }
  return { ...result, moved, refused }
}

/** The shell as the sidebar domain's host. */
export const shellSidebarHost: SidebarHost = {
  hostsWindows: true,
  // Known = every window that exists: live, or persisted for the next boot.
  knownWindowKeys: () => new Set([...windowState.keys(), ...windowRegistry.liveKeys()]),
  isPrimary: (windowKey) => {
    const win = windowRegistry.getWindowByKey(windowKey)
    return win !== null && windowRegistry.isPrimary(win.id)
  },
  isLive: (windowKey) => windowRegistry.getWindowByKey(windowKey) !== null,
  movable: (sessionIds, targetWindowKey) => {
    const target = windowRegistry.getWindowByKey(targetWindowKey)
    const movable: string[] = []
    const refused: MoveRefusal[] = []
    for (const id of sessionIds) {
      const why = refusal(id, target)
      if (why) refused.push(why)
      else movable.push(id)
    }
    return { movable, refused }
  },
  rehome: (sessionIds, targetWindowKey, options) =>
    rehomeSessions(sessionIds, targetWindowKey, options),
  groupMovedAway: (windowKey, groupId) => {
    const source = windowRegistry.getWindowByKey(windowKey)
    if (source && !source.isDestroyed()) source.webContents.send('group:removed-for-move', groupId)
  }
}

export type SidebarTransport = 'server' | 'shell'

let instance: SidebarLayouts | null = null
let transport: SidebarTransport | null = null

/** The one instance, built on first use (after `app` is ready, so the data
 *  folder is the right one under `--user-data-dir`). Every change is
 *  mirrored to the window it belongs to over IPC. */
export function sidebarLayouts(): SidebarLayouts {
  if (instance) return instance
  instance = new SidebarLayouts(fileSidebarStorage(app.getPath('userData')), shellSidebarHost)
  instance.onChange((event) => {
    // On the server's road the push channel carries the change and the
    // shell sends nothing, so a window hears each change once.
    if (transport === 'server') return
    const key = event._tag === 'sidebar.layout_changed' ? event.layout.windowKey : event.windowKey
    const win = windowRegistry.getWindowByKey(key)
    if (!win || win.isDestroyed()) return
    if (event._tag === 'sidebar.layout_changed')
      win.webContents.send('sidebar:layout-changed', event)
    else win.webContents.send('sidebar:layout-removed', event)
  })
  return instance
}

/** How a window reaches the sidebar: through the server's client when the
 *  server runs in this process, over IPC when the app is attached to a
 *  server elsewhere. Null until the boot has decided; the preload asks
 *  again until it knows, and before that every call goes over IPC, which
 *  lands on the same instance either way. */
export function sidebarTransport(): SidebarTransport | null {
  return transport
}

export function setSidebarTransport(next: SidebarTransport): void {
  transport = next
}

/** Tests only: forget the instance so the next call builds a fresh one. */
export function resetSidebarLayoutsForTests(): void {
  instance = null
  transport = null
}
