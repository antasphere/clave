import { ipcMain, BrowserWindow } from 'electron'
import { sessionManager } from './session-manager'
import { UserMessageSchema } from '../../shared/session-model'
import { windowRegistry } from '../window-registry'

let registered = false
/** Second consumers have independent subscriptions; destroying their window
 * removes only their listeners, never the process or xterm's subscription. */
export function registerSessionIpc(): void {
  if (registered || !ipcMain?.handle) return
  registered = true
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
    return sessionManager.get(id)
  })
  ipcMain.handle('sessions:unsubscribe', (event, id: string) => {
    subscriptions.get(event.sender.id)?.get(id)?.()
    subscriptions.get(event.sender.id)?.delete(id)
  })
  ipcMain.handle('sessions:write', (event, id: string, input: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    if (!key || sessionManager.get(id)?.windowKey !== key)
      throw new Error('Session belongs to another window')
    sessionManager.write(id, input instanceof Uint8Array ? input : UserMessageSchema.parse(input))
  })
}
