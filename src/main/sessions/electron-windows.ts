/**
 * The shell's session windows port (`windows.ts`): the window registry for
 * the bindings and the workspace, `webContents.send` for the per-window arm,
 * and the renderer bridge for the linked-document flush a stop owes. The
 * one file of the sessions that may import Electron; the PTY handlers
 * install it at boot and nothing in the session host imports it.
 */
import type { BrowserWindow } from 'electron'
import { windowRegistry } from '../window-registry'
import { linkedDocuments } from '../linked-documents/runtime'
import { callRenderer } from '../mcp/mcp-bridge'
import type { SessionWindowsPort } from './windows'

const live = (win: BrowserWindow | null): BrowserWindow | null =>
  win && !win.isDestroyed() ? win : null

export const electronSessionWindows: SessionWindowsPort = {
  workspaceOf: (windowKey) => {
    const win = live(windowRegistry.getWindowByKey(windowKey))
    return win ? windowRegistry.getWorkspaceForWindow(win.id) : null
  },
  bind: (sessionId, windowKey) => {
    const win = live(windowRegistry.getWindowByKey(windowKey))
    if (win) windowRegistry.bindSession(sessionId, win.id)
  },
  unbind: (sessionId) => windowRegistry.unbindSession(sessionId),
  windowOf: (sessionId) => {
    const win = live(windowRegistry.getWindowForSession(sessionId))
    return win ? windowRegistry.getKeyForWindow(win.id) : null
  },
  send: (windowKey, channel, ...args) => {
    if (!windowKey) return
    const win = live(windowRegistry.getWindowByKey(windowKey))
    if (win) win.webContents.send(channel, ...args)
  },
  beforeStop: async (sessionId) => {
    const owner = live(windowRegistry.getWindowForSession(sessionId))
    if (!owner) return
    if (
      linkedDocuments()
        .list()
        .some((d) => d.sessionId === sessionId)
    )
      await callRenderer('flushLinkedDocument', { sessionId, allowConflict: true }, owner)
  }
}
