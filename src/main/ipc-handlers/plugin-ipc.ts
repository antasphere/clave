import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PluginStore, pluginFile } from '../plugins/plugin-store'
import { PluginHost } from '../plugins/plugin-host'
import { ptyManager } from '../pty-manager'
import { registerPreviewFile, unregisterPreviewFile } from '../preview-protocol'
import { TEST_NO_ACTIVATE } from '../test-mode'
import type { PluginPermission } from '@clave/plugin-sdk'

export function registerPluginHandlers(): void {
  const root = TEST_NO_ACTIVATE
    ? join(app.getPath('userData'), 'clave-plugins')
    : join(homedir(), '.clave')
  const bundled = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'plugins')
  let store: PluginStore
  let initializationError: string | undefined
  try {
    store = new PluginStore(root, bundled, app.getVersion())
    store.discover()
  } catch (error) {
    initializationError = `Plugin registry could not be read: ${String(error)}`
    console.error(initializationError)
  }
  const broadcast = (): void => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send('plugins:changed')
  }
  const surfaces = new Map<string, string>()
  const secretRequests = new Map<
    string,
    {
      pluginId: string
      windowId: number
      resolve: (value: string | null) => void
      timer: NodeJS.Timeout
      title: string
      description?: string
    }
  >()
  const clearSecrets = (id: string): void => {
    for (const [key, request] of secretRequests)
      if (request.pluginId === id) {
        clearTimeout(request.timer)
        secretRequests.delete(key)
        request.resolve(null)
      }
  }
  const host = !initializationError
    ? new PluginHost(store!, {
        sessions: {
          list: () => ptyManager.getAllSessions(),
          send: (id, text) => {
            if (!ptyManager.getSession(id)?.alive) throw new Error('Session is not running')
            ptyManager.write(id, text)
          }
        },
        changed: broadcast,
        stopped: (id) => {
          const file = surfaces.get(id)
          if (file) unregisterPreviewFile(file)
          surfaces.delete(id)
          clearSecrets(id)
        },
        notify: (id, title, body) => {
          if (!TEST_NO_ACTIVATE && Notification.isSupported())
            new Notification({
              title: `${store.get(id).manifest?.name}: ${title}`,
              body: body ?? ''
            }).show()
        },
        requestSecret: (pluginId, title, description) => {
          if ([...secretRequests.values()].some((r) => r.pluginId === pluginId))
            return Promise.reject(new Error('A secret request is already pending'))
          const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
          if (!win) return Promise.resolve(null)
          return new Promise((resolve) => {
            const id = randomUUID()
            const timer = setTimeout(() => {
              secretRequests.delete(id)
              resolve(null)
              broadcast()
            }, 120_000)
            secretRequests.set(id, {
              pluginId,
              windowId: win.id,
              resolve,
              timer,
              title,
              description
            })
            broadcast()
          })
        }
      })
    : undefined
  // Only the app's top-level renderer may invoke management IPC, never a guest.
  const guard = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || event.senderFrame !== event.sender.mainFrame)
      throw new Error('Plugin management requires the app renderer')
    if (initializationError) throw new Error(initializationError)
    return win
  }
  ipcMain.handle('plugins:list', (event) => {
    guard(event)
    return store.list()
  })
  ipcMain.handle('plugins:enable', (event, id: string, grants: PluginPermission[]) => {
    guard(event)
    if (!Array.isArray(grants)) throw new Error('Permission grants are required')
    store.enable(id, grants)
    host!.start(id)
    broadcast()
  })
  ipcMain.handle('plugins:disable', (event, id: string) => {
    guard(event)
    store.disable(id)
    host!.stop(id)
  })
  ipcMain.handle('plugins:link', async (event, folder?: string) => {
    const win = guard(event)
    const selected =
      folder ??
      (
        await dialog.showOpenDialog(win, {
          properties: ['openDirectory'],
          title: 'Link Clave plugin folder'
        })
      ).filePaths[0]
    if (!selected) return null
    const id = store.link(selected)
    host!.reload()
    return id
  })
  ipcMain.handle('plugins:remove', (event, id: string) => {
    guard(event)
    if (store.get(id).source === 'bundled')
      throw new Error('Bundled plugins can be disabled, not removed')
    host!.stop(id)
    store.remove(id)
    broadcast()
  })
  ipcMain.handle('plugins:command', (event, id: string, command: string) => {
    guard(event)
    return host!.execute(id, command)
  })
  ipcMain.handle('plugins:panel', (event, id: string, panel: string) => {
    guard(event)
    const record = store.get(id)
    if (
      !record.enabled ||
      record.status !== 'active' ||
      !record.panels.includes(panel) ||
      record.manifest?.ui !== 'surface' ||
      !record.manifest.uiEntry
    )
      throw new Error('Panel is not active')
    const file = pluginFile(record.directory, record.manifest.uiEntry)
    surfaces.set(id, file)
    const net = record.permissionsGranted.includes('net') ? 'https: http:' : ''
    return registerPreviewFile(
      file,
      `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${net}; connect-src 'self' ${net}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
    )
  })
  ipcMain.handle('plugins:secrets', (event) => {
    const win = guard(event)
    return [...secretRequests]
      .filter(([, r]) => r.windowId === win.id)
      .map(([id, { pluginId, title, description }]) => ({ id, pluginId, title, description }))
  })
  ipcMain.handle('plugins:secret-reply', (event, id: string, value: string | null) => {
    const win = guard(event)
    const request = secretRequests.get(id)
    if (!request || request.windowId !== win.id) throw new Error('Unknown secret request')
    if (value !== null && (typeof value !== 'string' || value.length > 64_000))
      throw new Error('Invalid secret')
    clearTimeout(request.timer)
    secretRequests.delete(id)
    request.resolve(value)
    broadcast()
  })
  host?.startAll()
  app.once('before-quit', () => host?.close())
}
