import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { SkinStore } from '../skins/skin-store'
import { preferencesManager } from '../preferences-manager'

export function registerSkinHandlers(): void {
  const testMode = process.argv.includes('--test-no-activate')
  const root = testMode
    ? join(app.getPath('userData'), 'skins')
    : join(homedir(), '.clave', 'skins')
  const store = new SkinStore(
    root,
    app.getVersion(),
    () => preferencesManager.get('activeSkinId'),
    (id) => preferencesManager.set('activeSkinId', id),
    (state) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('skins:changed', state)
    }
  )
  ipcMain.handle('skins:list', () => store.list())
  ipcMain.handle('skins:activate', (_event, id: string) => store.activate(id))
  ipcMain.handle('skins:remove', (_event, id: string) => store.remove(id))
  ipcMain.handle('skins:import', async (_event, source?: string) => {
    if (!source) {
      const result = await dialog.showOpenDialog({
        title: 'Import skin',
        properties: ['openFile', 'openDirectory'],
        filters: [{ name: 'Skin tokens', extensions: ['json'] }]
      })
      if (result.canceled) return store.list()
      source = result.filePaths[0]
    }
    return store.import(source)
  })
  store.startWatching()
  app.once('will-quit', () => store.close())
}
