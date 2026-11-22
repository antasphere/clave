import { BrowserWindow, globalShortcut, ipcMain, type IpcMainEvent } from 'electron'
import { getStoredKeymapConfig } from './ipc-handlers/keymap-handlers'
import { preferencesManager } from './preferences-manager'
import { installE2eHooks } from './sessions/e2e-hooks'
import { TEST_NO_ACTIVATE } from './test-mode'
import { createUpdatesKey, readStatus, type UpdatesKey } from './updates-key-core'

/* The update key of Folio's play mode (PRDCT-4832): the wiring of
   `updates-key-core.ts` to the OS's shortcuts, the windows and the IPC. Each
   window reports its updates (`updates:status`); the key goes to the window
   it concerns, held system-wide ONLY while some window is active and the
   preference `updatesKeyEverywhere` is on, registered and unregistered by
   name (never `unregisterAll`: another module may register its own one
   day). Each window is told whether another one is speaking
   (`updates:elsewhere`) and asked to yield when the person starts a reading
   in another (`updates:yield`). Under `--test-no-activate` nothing reaches
   the OS: the list that would be held is kept for the specs
   (`__claveE2E.updatesKey`). */

export { pickWindow, readStatus, updateAccelerators } from './updates-key-core'
export type { UpdatesStatus } from './updates-key-core'

let key: UpdatesKey | null = null

/** The keymap changed: hold the new bindings. */
export function updatesKeyBindingsChanged(): void {
  key?.bindingsChanged()
}

export function registerUpdatesKey(): void {
  const updates = createUpdatesKey({
    register: (accelerator, press) =>
      TEST_NO_ACTIVATE ? true : globalShortcut.register(accelerator, press),
    unregister: (accelerator) => {
      if (!TEST_NO_ACTIVATE) globalShortcut.unregister(accelerator)
    },
    send: (windowId, message) => {
      const window = BrowserWindow.fromId(windowId)
      if (!window || window.isDestroyed()) return false
      if (message.channel === 'updates:elsewhere')
        window.webContents.send(message.channel, message.value)
      else window.webContents.send(message.channel)
      return true
    },
    bindings: () => getStoredKeymapConfig(),
    everywhere: () => preferencesManager.get('updatesKeyEverywhere') !== false,
    platform: process.platform,
    warn: (message) => console.warn(`[updates-key] ${message}`)
  })
  key = updates
  const known = new Set<number>()
  ipcMain.on('updates:status', (event: IpcMainEvent, raw: unknown) => {
    const status = readStatus(raw)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!status || !window) return
    const id = window.id
    if (!known.has(id)) {
      known.add(id)
      window.once('closed', () => {
        known.delete(id)
        updates.closed(id)
      })
    }
    updates.report(id, status)
  })
  ipcMain.handle('updates:toggle', () => updates.press())
  ipcMain.handle(
    'updates:key-everywhere:get',
    () => preferencesManager.get('updatesKeyEverywhere') !== false
  )
  ipcMain.handle('updates:key-everywhere:set', (_event, value: unknown) => {
    preferencesManager.set('updatesKeyEverywhere', value === true)
    updates.everywhereChanged()
    return value === true
  })
  installE2eHooks({
    updatesKey: { registered: () => updates.held(), press: () => updates.press() }
  })
}

/** On quit: the OS gets its keys back. */
export function releaseUpdatesKey(): void {
  key?.release()
}
