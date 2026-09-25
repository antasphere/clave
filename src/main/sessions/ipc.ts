import { ipcMain, BrowserWindow } from 'electron'
import { sessionManager } from './session-manager'
import { SessionInputSchema } from '../../shared/session-model'
import { preparePrompt } from './attachments'
import { windowRegistry } from '../window-registry'
import * as titleGenerator from '../title-generator'

/** Built-in adapters whose `provider_event` is the CLI's own frame, verbatim. */
const RAW_WIRE_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex'])

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
        // The built-in CLIs' raw wire frames stay in main. No view renders them,
        // and they are most of the stream: a Claude turn that writes one file
        // sends hundreds of tool-input chunks, and every event a window
        // receives re-renders its chat — the flood froze the window under long
        // lanes. A plugin provider's own events still pass: its view may read them.
        if (
          value.kind === 'event' &&
          value.event.type === 'provider_event' &&
          RAW_WIRE_PROVIDERS.has(value.event.provider)
        )
          return
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
    if (input instanceof Uint8Array) return sessionManager.write(id, input)
    const value = SessionInputSchema.parse(input)
    if (value.type !== 'user_message') return sessionManager.write(id, value)
    // A chat tab is named by its first message, and this is where that
    // message is first seen in main; the title comes back to the sender's
    // window on `session:auto-title:<id>`, as a terminal tab's does.
    if (win) titleGenerator.notifyChatMessage(id, value.text, win)
    // A user message's prepared prompt is main's to build, from the attachment
    // records and the files they name, never the renderer's to supply: the
    // files are read here, at send time, against the adapter's capabilities,
    // and a failure rejects the write so the composer keeps its draft.
    const attachments = value.attachments?.length ? value.attachments : undefined
    if (!attachments) return sessionManager.write(id, { type: 'user_message', text: value.text })
    return preparePrompt(value.text, attachments, sessionManager.capabilities(id).images).then(
      (prepared) =>
        sessionManager.write(id, { type: 'user_message', text: value.text, attachments, prepared })
    )
  })
  ipcMain.handle('sessions:capabilities', (event, id: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    if (!key || sessionManager.get(id)?.windowKey !== key)
      throw new Error('Session belongs to another window')
    return sessionManager.capabilities(id)
  })
  ipcMain.handle('sessions:models', (event, id: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    if (!key || sessionManager.get(id)?.windowKey !== key)
      throw new Error('Session belongs to another window')
    return sessionManager.models(id)
  })
  // A resumed conversation's past, a page at a time and newest first, so a
  // view paints the end of a long conversation at once and reads further back
  // only as the reader scrolls there.
  ipcMain.handle('sessions:history', (event, id: string, before: unknown, limit: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    if (!key || sessionManager.get(id)?.windowKey !== key)
      throw new Error('Session belongs to another window')
    const count = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
    return sessionManager.history(id, count(before), count(limit))
  })
  ipcMain.handle('sessions:commands', (event, id: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win && windowRegistry.getKeyForWindow(win.id)
    if (!key || sessionManager.get(id)?.windowKey !== key)
      throw new Error('Session belongs to another window')
    return sessionManager.commands(id)
  })
}
