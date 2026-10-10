import { ipcMain, BrowserWindow } from 'electron'
import type { MoveResult } from '@clave/contract/sidebar'
import { windowRegistry, type WindowIdentity } from '../window-registry'
import { workspaceManager } from '../workspace-manager'
import { windowState } from '../window-state'
import { rehomeAck } from '../rehome-ack'
import {
  rehomeSessions,
  sidebarLayouts,
  isAttachedServer,
  withAttachedRelease,
  groupLinkedSessionIds,
  type RehomePayload
} from '../sidebar-layouts'
import { serverClient } from '../mcp/server-client'

export type { MoveResult, RehomePayload }
export { rehomeSessions }

/** What a renderer learns about itself, and only itself: its window id, its
 *  persisted key, the workspace it shows, whether it is the primary. Pushed
 *  again as `window:identity-changed` when the primary is re-elected. */
export function identityFor(windowId: number): WindowIdentity | null {
  return windowRegistry.identityOf(windowId)
}

export function pushIdentity(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const identity = identityFor(win.id)
  if (identity) win.webContents.send('window:identity-changed', identity)
}

export function broadcastIdentities(): void {
  for (const win of windowRegistry.listWindows()) pushIdentity(win)
}

export interface WindowHandlerDeps {
  /** Open a new window on a workspace — lives in main/index.ts next to
   *  createWindow; injected so this module never imports the entry. */
  openWindow: (workspaceId: string | null) => { windowId: number }
}

// ── Re-homing ────────────────────────────────────────────────────────────────

/** Renderers acknowledge `session:rehome` once the adoption ran (see
 *  rehome-ack.ts for the rule: waiters are registered BEFORE the move is
 *  dispatched, unsolicited acks are dropped). */
export function awaitRehomed(sessionIds: string[], timeoutMs = 10_000): Promise<void> {
  return rehomeAck.wait(sessionIds, timeoutMs)
}

/**
 * Move live sessions to the window `targetWindowId`, through the sidebar
 * domain: it decides which window's layout loses each session and which
 * gains it, and asks the shell (`rehomeSessions`) to detach and hand them
 * over. A target that is not a live Clave window refuses every id.
 */
export async function moveSessionsToWindow(
  sessionIds: string[],
  targetWindowId: number,
  focus = true
): Promise<MoveResult> {
  const targetKey = windowRegistry.getKeyForWindow(targetWindowId)
  if (!targetKey) {
    return { moved: [], refused: sessionIds.map((id) => ({ sessionId: id, reason: 'not-live' })) }
  }
  // Attached, the sessions are the server's: release them there first (it
  // decides which can move), then run the same layout logic with that
  // outcome (`withAttachedRelease`, sidebar-layouts.ts).
  if (isAttachedServer()) {
    const outcome = await serverClient.api().then((api) => api.sessions.release(sessionIds))
    const moved = withAttachedRelease(outcome, () =>
      sidebarLayouts().moveSessionsToWindow(sessionIds, targetKey, focus)
    )
    return moved.ok
      ? moved.value
      : { moved: [], refused: sessionIds.map((id) => ({ sessionId: id, reason: 'not-live' })) }
  }
  const result = sidebarLayouts().moveSessionsToWindow(sessionIds, targetKey, focus)
  if (result.ok) return result.value
  return { moved: [], refused: sessionIds.map((id) => ({ sessionId: id, reason: 'not-live' })) }
}

export function registerWindowHandlers(deps: WindowHandlerDeps): void {
  ipcMain.handle('window:identity', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? identityFor(win.id) : null
  })

  // macOS hides the traffic lights in fullscreen, so the chrome that was
  // keeping clear of them has to know. Per window, never broadcast: two
  // windows are rarely in the same state.
  ipcMain.handle('window:is-fullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? win.isFullScreen() : false
  })

  ipcMain.handle('window:list', () =>
    windowRegistry
      .listWindows()
      .map((w) => identityFor(w.id))
      .filter((i): i is WindowIdentity => i !== null)
  )

  // A window switching its workspace tells main FIRST, so the registry is
  // current when the next pty:spawn stamps its record (IPC is FIFO). Any
  // window may show any workspace; the switch is persisted so the window
  // comes back on it, and becomes the last-active default.
  ipcMain.handle('window:set-workspace', (event, workspaceId: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false as const, reason: 'no-window' as const }
    const target = typeof workspaceId === 'string' ? workspaceId : null
    if (target !== null && !workspaceManager.isRegistered(target)) {
      return { ok: false as const, reason: 'unknown-workspace' as const }
    }
    windowRegistry.setWindowWorkspace(win.id, target)
    const key = windowRegistry.getKeyForWindow(win.id)
    if (key) windowState.upsert(key, { workspaceId: target })
    workspaceManager.setLastActive(target)
    return { ok: true as const }
  })

  // The single reach for "a new window": the File menu, the popover, the
  // clave_open_window tool and the end-to-end harness all come through here.
  // No workspace → the asking window's own (the app once more, where you are).
  ipcMain.handle('window:open', (event, workspaceId?: unknown) => {
    let target: string | null
    if (typeof workspaceId === 'string') {
      if (!workspaceManager.isRegistered(workspaceId)) {
        throw new Error(`No registered workspace with id "${workspaceId}"`)
      }
      target = workspaceId
    } else {
      const win = BrowserWindow.fromWebContents(event.sender)
      target =
        (win ? windowRegistry.getWorkspaceForWindow(win.id) : null) ??
        workspaceManager.resolveInitialWorkspaceId()
    }
    return deps.openWindow(target)
  })

  ipcMain.handle(
    'window:move-sessions',
    async (_event, sessionIds: unknown, targetWindowId: unknown): Promise<MoveResult> => {
      const ids = Array.isArray(sessionIds)
        ? sessionIds.filter((x): x is string => typeof x === 'string')
        : []
      if (typeof targetWindowId !== 'number') {
        return { moved: [], refused: ids.map((id) => ({ sessionId: id, reason: 'not-live' })) }
      }
      return moveSessionsToWindow(ids, targetWindowId)
    }
  )

  // A group moves whole: its members AND its quick-launch terminals' live
  // sessions travel (detach + re-adopt), and the target window takes the
  // group object carrying only what actually moved. The sidebar domain
  // holds the group (the renderer's copy is named by its id and nothing
  // else is read from it); the source drops its copy on `ok`, and what
  // could not move (not live, not tmux-backed) stays there as plain tabs.
  // A group whose members all stayed does not move at all: `ok: false`,
  // nothing changes anywhere.
  ipcMain.handle(
    'window:move-group',
    async (
      event,
      group: unknown,
      targetWindowId: unknown
    ): Promise<MoveResult & { ok: boolean }> => {
      const g = group as { id?: unknown } | null
      const sender = BrowserWindow.fromWebContents(event.sender)
      const sourceKey = sender ? windowRegistry.getKeyForWindow(sender.id) : null
      const targetKey =
        typeof targetWindowId === 'number' ? windowRegistry.getKeyForWindow(targetWindowId) : null
      if (!sourceKey || !targetKey || !g || typeof g.id !== 'string' || sourceKey === targetKey) {
        return { ok: false, moved: [], refused: [] }
      }
      if (isAttachedServer()) {
        // The group's own live sessions are released on the server first,
        // then the same group-move logic runs with that outcome.
        const linked = groupLinkedSessionIds(sourceKey, g.id)
        const outcome = await serverClient.api().then((api) => api.sessions.release(linked))
        const moved = withAttachedRelease(outcome, () =>
          sidebarLayouts().moveGroupToWindow(sourceKey, g.id as string, targetKey)
        )
        return moved.ok ? moved.value : { ok: false, moved: [], refused: [] }
      }
      const result = sidebarLayouts().moveGroupToWindow(sourceKey, g.id, targetKey)
      return result.ok ? result.value : { ok: false, moved: [], refused: [] }
    }
  )

  // The renderer's acknowledgement that `session:rehome` was adopted.
  ipcMain.on('window:rehomed', (_event, sessionIds: unknown) => {
    if (Array.isArray(sessionIds)) {
      rehomeAck.ack(sessionIds.filter((x): x is string => typeof x === 'string'))
    }
  })
}
