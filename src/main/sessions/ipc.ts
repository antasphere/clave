/**
 * The session calls over IPC, for a window the server has not reached: the
 * first moments of a boot, and an app running without a server. Each handler
 * checks that the asking window owns the session, then answers from the same
 * session host the server answers from (`host.ts`), so the two transports
 * never drift. A window on the server never calls these.
 */
import { ipcMain, BrowserWindow } from 'electron'
import { sessionManager } from './session-manager'
import { SessionInputSchema } from '../../shared/session-model'
import type { SessionWrite } from '@clave/contract/sessions'
import { windowRegistry } from '../window-registry'
import { hasServerEventPublisher } from '../server/session-events'
import { getSessionHost } from './host'

let registered = false
/** Second consumers have independent subscriptions; destroying their window
 * removes only their listeners, never the process or xterm's subscription. */
export function registerSessionIpc(): void {
  if (registered || !ipcMain?.handle) return
  registered = true
  sessionManager.subscribeAll((id, stream) => {
    if (stream.kind !== 'event' || stream.event.type !== 'state_change') return
    // With the server running, the state travels as `session.state_changed`
    // on the push channel (server/clave-server.ts); the per-window send is
    // for an app without one.
    if (hasServerEventPublisher()) return
    const record = sessionManager.get(id)
    if (record?.transport !== 'events') return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && windowRegistry.getKeyForWindow(win.id) === record.windowKey)
        win.webContents.send(`agent:state:${id}`, stream.event.state)
    }
  })
  const subscriptions = new Map<number, Map<string, () => void>>()
  const watched = new Set<number>()
  /** The asking window's key, when it owns the session. */
  const owning = (event: Electron.IpcMainInvokeEvent, id: string): string => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    if (!key || sessionManager.get(id)?.windowKey !== key)
      throw new Error('Session belongs to another window')
    return key
  }
  ipcMain.handle('sessions:list', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    return key ? getSessionHost().list(key) : []
  })
  ipcMain.handle('sessions:subscribe', (event, id: string) => {
    if (typeof id !== 'string' || !sessionManager.get(id)) throw new Error('Unknown session')
    const sender = event.sender
    const win = BrowserWindow.fromWebContents(sender)
    if (!win) throw new Error('Session subscriptions require an app window')
    const windowKey = owning(event, id)
    let owned = subscriptions.get(sender.id)
    if (!owned) {
      owned = new Map()
      subscriptions.set(sender.id, owned)
    }
    owned.get(id)?.()
    const host = getSessionHost()
    const exit = host.subscribeExit(id, (code) => {
      if (!sender.isDestroyed()) sender.send(`sessions:exit:${id}`, code)
    })
    const stream = host.subscribe(id, (value) => {
      if (!sender.isDestroyed()) sender.send(`sessions:stream:${id}`, value)
    })
    owned.set(id, () => {
      stream()
      exit()
    })
    if (!watched.has(sender.id)) {
      watched.add(sender.id)
      sender.once('destroyed', () => {
        for (const off of subscriptions.get(sender.id)?.values() ?? []) off()
        subscriptions.delete(sender.id)
        watched.delete(sender.id)
        sessionManager.detachWindow(windowKey)
      })
    }
    return sessionManager.get(id)
  })
  ipcMain.handle('sessions:unsubscribe', (event, id: string) => {
    subscriptions.get(event.sender.id)?.get(id)?.()
    subscriptions.get(event.sender.id)?.delete(id)
  })
  // The pane's view picker. The window that owns the session is the only one
  // allowed to change what it is read in, the same rule every session call keeps.
  ipcMain.handle('sessions:set-view', (event, id: string, viewId: unknown) => {
    owning(event, id)
    if (viewId !== null && typeof viewId !== 'string') throw new Error('Invalid view id')
    return getSessionHost().setView(id, viewId)
  })
  ipcMain.handle('sessions:write', (event, id: string, input: unknown) => {
    owning(event, id)
    const write: SessionWrite =
      input instanceof Uint8Array
        ? { type: 'bytes', data: input }
        : (SessionInputSchema.parse(input) as SessionWrite)
    return getSessionHost().write(id, write)
  })
  ipcMain.handle('sessions:capabilities', (event, id: string) => {
    owning(event, id)
    return getSessionHost().capabilities(id)
  })
  ipcMain.handle('sessions:models', (event, id: string) => {
    owning(event, id)
    return getSessionHost().models(id)
  })
  // A resumed conversation's past, a page at a time and newest first, so a
  // view paints the end of a long conversation at once and reads further back
  // only as the reader scrolls there.
  ipcMain.handle('sessions:history', (event, id: string, before: unknown, limit: unknown) => {
    owning(event, id)
    const count = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
    return getSessionHost().history(id, count(before), count(limit))
  })
  ipcMain.handle('sessions:commands', (event, id: string) => {
    owning(event, id)
    return getSessionHost().commands(id)
  })
}
