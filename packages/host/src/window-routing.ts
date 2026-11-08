import { BrowserWindow } from 'electron'
import { windowRegistry } from './window-registry'
import { TEST_NO_ACTIVATE } from './test-mode'

/**
 * Main-process routing helpers for multi-window Clave (PRDCT-1703, slice 2).
 * Replaces the single-window window lookup (deleted): a main-process
 * event now goes to the window that should receive it — the one hosting a
 * given session, the one showing a workspace, the focused/primary window, or
 * every window — resolved through the WindowRegistry.
 */

/** Send to EVERY live window. For app-level events with no single owner
 *  (updater state, remote-agent messages, ssh connection lifecycle): each
 *  renderer keeps its own copy of that state, so all must hear it. */
export function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of windowRegistry.listWindows()) {
    win.webContents.send(channel, ...args)
  }
}

/** The focused Clave window, else the primary. Under `--test-no-activate`
 *  the OS grants no focus, so this resolves to the primary — which is the
 *  correct single-window-equivalent fallback. */
export function focusedOrPrimaryWindow(): BrowserWindow | null {
  return windowRegistry.resolveTargetWindow({})
}

/** The window hosting a session (its renderer holds the xterm), or null. */
export function windowForSession(sessionId: string): BrowserWindow | null {
  return windowRegistry.getWindowForSession(sessionId)
}

/** THE one way to put a window in front of the user: restore, show, focus.
 *  Under `--test-no-activate` it does nothing at all — a test instance must
 *  never appear on or take the human's screen, whatever path asks (a menu
 *  item, a notification click, a secret request, an agent's focus call). */
export function bringForward(win: BrowserWindow | null | undefined): void {
  if (!win || win.isDestroyed() || TEST_NO_ACTIVATE) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
