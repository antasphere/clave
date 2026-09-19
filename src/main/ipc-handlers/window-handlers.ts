import { ipcMain, BrowserWindow } from 'electron'
import { windowRegistry, type WindowIdentity } from '../window-registry'
import { workspaceManager } from '../workspace-manager'
import { windowState } from '../window-state'
import { ptyManager } from '../pty-manager'
import { sidebarLayoutManager, type SidebarLayout } from '../sidebar-layout-manager'
import { rehomeAck } from '../rehome-ack'
import { conversationClient, isConversationId } from '../conversations/runtime'
import { revokePluginSessionViews } from '../runtime-plugins/host'

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

/** What a target window receives to take in sessions (and, on a window
 *  close, the closing window's groups with them). */
export interface RehomePayload {
  sessionIds: string[]
  layout: SidebarLayout | null
  /** A deliberate move (the user's, an agent's) takes focus in its new
   *  window like a spawn does; a window-close hand-over stays neutral. */
  focus: boolean
}

export interface MoveResult {
  moved: string[]
  /** Sessions that could not move and why: not live, or not tmux-backed (a
   *  plain pty's scrollback lives in one renderer and cannot be re-attached). */
  refused: { sessionId: string; reason: 'not-live' | 'not-tmux' | 'same-window' }[]
}

// ── Re-homing ────────────────────────────────────────────────────────────────

/** Renderers acknowledge `session:rehome` once the adoption ran (see
 *  rehome-ack.ts for the rule: waiters are registered BEFORE the move is
 *  dispatched, unsolicited acks are dropped). */
export function awaitRehomed(sessionIds: string[], timeoutMs = 10_000): Promise<void> {
  return rehomeAck.wait(sessionIds, timeoutMs)
}

/**
 * Move live sessions to the window `targetWindowId`. For each tmux-backed
 * session hosted elsewhere: tell its old host to drop the tab (a MOVE, not a
 * death — the tab is removed without touching the pty), detach the pty
 * (`kill(id, false)` keeps the tmux session and its record alive), unbind,
 * then hand the ids to the target, whose renderer re-adopts them
 * (reattaching to the same tmux session, scrollback intact, the id preserved
 * so MCP addressing and exchange capture survive). A plain-pty session is
 * refused: its process would die with the detach.
 */
export async function moveSessionsToWindow(
  sessionIds: string[],
  targetWindowId: number,
  layout: SidebarLayout | null = null,
  focus = true
): Promise<MoveResult> {
  const target = windowRegistry.getWindow(targetWindowId)
  const result: MoveResult = { moved: [], refused: [] }
  if (!target) {
    for (const id of sessionIds) result.refused.push({ sessionId: id, reason: 'not-live' })
    return result
  }
  for (const id of sessionIds) {
    if (isConversationId(id)) {
      const oldHost = windowRegistry.getWindowForSession(id)
      if (oldHost?.id === target.id) {
        result.refused.push({ sessionId: id, reason: 'same-window' })
        continue
      }
      const client = await conversationClient()
      const snapshot = await client.snapshot(id)
      if (snapshot.session.status === 'closed') {
        result.refused.push({ sessionId: id, reason: 'not-live' })
        continue
      }
      await client.updateMetadata(id, { windowKey: windowRegistry.getKeyForWindow(target.id)! })
      if (snapshot.session.legacyImport && !snapshot.session.legacyImport.complete) {
        ptyManager.setSessionWindowKey(
          snapshot.session.legacyImport.sourceId,
          windowRegistry.getKeyForWindow(target.id)!
        )
      }
      revokePluginSessionViews(id)
      if (oldHost) oldHost.webContents.send('session:removed-for-rehome', id)
      windowRegistry.bindSession(id, target.id)
      result.moved.push(id)
      continue
    }
    const session = ptyManager.getSession(id)
    if (!session) {
      // A migration placeholder can move without attaching or stopping its agent.
      if (ptyManager.readLegacyMigrationRecord(id)) {
        const oldHost = windowRegistry.getWindowForSession(id)
        if (oldHost?.id === target.id) {
          result.refused.push({ sessionId: id, reason: 'same-window' })
          continue
        }
        ptyManager.setSessionWindowKey(id, windowRegistry.getKeyForWindow(target.id)!)
        if (oldHost) oldHost.webContents.send('session:removed-for-rehome', id)
        windowRegistry.bindSession(id, target.id)
        result.moved.push(id)
        continue
      }
      result.refused.push({ sessionId: id, reason: 'not-live' })
      continue
    }
    const oldHost = windowRegistry.getWindowForSession(id)
    if (oldHost && oldHost.id === target.id) {
      result.refused.push({ sessionId: id, reason: 'same-window' })
      continue
    }
    if (!session.tmuxName) {
      result.refused.push({ sessionId: id, reason: 'not-tmux' })
      continue
    }
    // Tell the old host to drop the tab FIRST, so its terminal unmounts before
    // the detach's pty:exit could paint "[Session ended]" on a moving tab.
    if (oldHost) oldHost.webContents.send('session:removed-for-rehome', id)
    ptyManager.setSessionWindowKey(id, windowRegistry.getKeyForWindow(target.id)!)
    ptyManager.kill(id, false) // detach: tmux session and record survive
    windowRegistry.bindSession(id, target.id)
    result.moved.push(id)
  }
  if (result.moved.length > 0 || (layout && layout.groups.length > 0)) {
    const payload: RehomePayload = { sessionIds: result.moved, layout, focus }
    target.webContents.send('session:rehome', payload)
  }
  return result
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
  // group object carrying only what actually moved. The source drops its
  // copy on `ok`; what could not move (not live, not tmux-backed) stays
  // there as plain tabs. A group whose members all stayed does not move at
  // all — `ok: false`, nothing changes anywhere.
  ipcMain.handle(
    'window:move-group',
    async (event, group: unknown, targetWindowId: unknown): Promise<MoveResult & { ok: boolean }> => {
      const g = group as
        | { id?: unknown; sessionIds?: unknown; terminals?: unknown }
        | null
      const target = typeof targetWindowId === 'number' ? windowRegistry.getWindow(targetWindowId) : null
      const sender = BrowserWindow.fromWebContents(event.sender)
      if (!target || !g || typeof g.id !== 'string' || (sender && sender.id === target.id)) {
        return { ok: false, moved: [], refused: [] }
      }
      const members = Array.isArray(g.sessionIds)
        ? g.sessionIds.filter((x): x is string => typeof x === 'string')
        : []
      const terminals = Array.isArray(g.terminals)
        ? (g.terminals as { sessionId?: unknown }[]).filter(
            (t) => t && typeof t === 'object'
          )
        : []
      const terminalIds = terminals
        .map((t) => t.sessionId)
        .filter((x): x is string => typeof x === 'string')
      const linked = [...members, ...terminalIds]
      // Decide first, send nothing on a refusal: the detach happens inside
      // moveSessionsToWindow, so a dry check of the same rules comes first.
      const movable = linked.filter((id) => {
        const session = ptyManager.getSession(id)
        const host = windowRegistry.getWindowForSession(id)
        return (
          (isConversationId(id) ||
            (!!session && !!session.tmuxName) ||
            (!session && !!ptyManager.readLegacyMigrationRecord(id))) &&
          (!host || host.id !== target.id)
        )
      })
      if (linked.length > 0 && movable.length === 0) {
        return {
          ok: false,
          moved: [],
          refused: linked.map((id) => ({
            sessionId: id,
            reason: ptyManager.getSession(id) ? 'not-tmux' : 'not-live'
          }))
        }
      }
      const movedSet = new Set(movable)
      const handed = {
        ...(group as Record<string, unknown>),
        sessionIds: members.filter((id) => movedSet.has(id)),
        terminals: terminals.map((t) => ({
          ...t,
          sessionId: typeof t.sessionId === 'string' && movedSet.has(t.sessionId) ? t.sessionId : null
        }))
      }
      const layout: SidebarLayout = { groups: [handed], displayOrder: [g.id] }
      const outcome = await moveSessionsToWindow(movable, target.id, layout)
      // The source drops its copy of the group; members and terminals that
      // could not move stay behind as plain tabs (the renderer re-places them).
      if (sender && !sender.isDestroyed()) sender.webContents.send('group:removed-for-move', g.id)
      const refused: MoveResult['refused'] = [
        ...outcome.refused,
        ...linked
          .filter((id) => !movedSet.has(id))
          .map((id) => ({
            sessionId: id,
            reason: (ptyManager.getSession(id) ? 'not-tmux' : 'not-live') as 'not-tmux' | 'not-live'
          }))
      ]
      return { ok: true, moved: outcome.moved, refused }
    }
  )

  // The renderer's acknowledgement that `session:rehome` was adopted.
  ipcMain.on('window:rehomed', (_event, sessionIds: unknown) => {
    if (Array.isArray(sessionIds)) {
      rehomeAck.ack(sessionIds.filter((x): x is string => typeof x === 'string'))
    }
  })
}

/** The closing window's groups, handed to the primary with its sessions, and
 *  its file removed: the primary persists what it absorbed into its own. */
export function takeClosingLayout(windowKey: string): SidebarLayout {
  const layout = sidebarLayoutManager.loadForWindow(windowKey)
  sidebarLayoutManager.deleteForWindow(windowKey)
  return layout
}
