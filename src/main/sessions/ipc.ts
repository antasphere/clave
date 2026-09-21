import { ipcMain, BrowserWindow } from 'electron'
import { sessionManager } from './session-manager'
import { SessionInputSchema } from '../../shared/session-model'
import { windowRegistry } from '../window-registry'

let registered = false
/** Second consumers have independent subscriptions; destroying their window
 * removes only their listeners, never the process or xterm's subscription. */
export function registerSessionIpc(): void {
  if (registered || !ipcMain?.handle) return
  registered = true
  sessionManager.subscribeAll((id, stream) => {
    if (stream.kind !== 'event' || stream.event.type !== 'state_change') return
    const record = sessionManager.get(id)
    if (record?.transport !== 'events') return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && windowRegistry.getKeyForWindow(win.id) === record.windowKey)
        win.webContents.send(`agent:state:${id}`, stream.event.state)
    }
  })
  const subscriptions = new Map<number, Map<string, () => void>>()
  const watched = new Set<number>()
  ipcMain.handle('sessions:list', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    return key ? sessionManager.list(key) : []
  })
  ipcMain.handle('sessions:subscribe', (event, id: string) => {
    if (typeof id !== 'string' || !sessionManager.get(id)) throw new Error('Unknown session')
    const sender = event.sender
    const win = BrowserWindow.fromWebContents(sender)
    if (!win) throw new Error('Session subscriptions require an app window')
    const windowKey = windowRegistry.getKeyForWindow(win.id)
    if (!windowKey || sessionManager.get(id)?.windowKey !== windowKey)
      throw new Error('Session belongs to another window')
    let owned = subscriptions.get(sender.id)
    if (!owned) {
      owned = new Map()
      subscriptions.set(sender.id, owned)
    }
    owned.get(id)?.()
    const stream = sessionManager.subscribe(
      id,
      (value) => {
        if (!sender.isDestroyed()) sender.send(`sessions:stream:${id}`, value)
      },
      windowKey
    )
    const exit = sessionManager.subscribeExit(
      id,
      (code) => {
        if (!sender.isDestroyed()) sender.send(`sessions:exit:${id}`, code)
      },
      windowKey
    )
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
    sessionManager.ready(id)
    return sessionManager.get(id)
  })
  ipcMain.handle('sessions:unsubscribe', (event, id: string) => {
    subscriptions.get(event.sender.id)?.get(id)?.()
    subscriptions.get(event.sender.id)?.delete(id)
  })
  // The pane's view picker. The window that owns the session is the only one
  // allowed to change what it is read in, the same rule every session call keeps.
  ipcMain.handle('sessions:set-view', (event, id: string, viewId: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    if (!key || sessionManager.get(id)?.windowKey !== key)
      throw new Error('Session belongs to another window')
    if (viewId !== null && typeof viewId !== 'string') throw new Error('Invalid view id')
    return sessionManager.setView(id, viewId)
  })
  ipcMain.handle('sessions:write', (event, id: string, input: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    if (!key || sessionManager.get(id)?.windowKey !== key)
      throw new Error('Session belongs to another window')
    sessionManager.write(id, input instanceof Uint8Array ? input : SessionInputSchema.parse(input))
  })
  ipcMain.handle('sessions:models', (event, id: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    if (!key || sessionManager.get(id)?.windowKey !== key)
      throw new Error('Session belongs to another window')
    return sessionManager.models(id)
  })
  ipcMain.handle('sessions:commands', (event, id: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    if (!key || sessionManager.get(id)?.windowKey !== key)
      throw new Error('Session belongs to another window')
    return sessionManager.commands(id)
  })
}
