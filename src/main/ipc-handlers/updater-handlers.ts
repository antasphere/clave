import { ipcMain } from 'electron'
import {
  installUpdate,
  startDownload,
  cancelDownload,
  openUpdaterLog,
  openReleasesPage,
  checkForUpdatesNow,
  getUpdaterState,
  setPrereleaseUpdates,
  type DownloadAttempt
} from '../auto-updater'

export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:install', () => installUpdate())
  ipcMain.handle('updater:start-download', (_event, attempt?: DownloadAttempt) =>
    startDownload(attempt === 'retry' ? 'retry' : 'first')
  )
  ipcMain.handle('updater:cancel-download', () => cancelDownload())
  ipcMain.handle('updater:open-log', () => openUpdaterLog())
  ipcMain.handle('updater:open-releases', () => openReleasesPage())
  // The pull half of the updater. The renderer asks on mount instead of hoping
  // it was listening when the one push went out.
  ipcMain.handle('updater:get-state', () => getUpdaterState())
  ipcMain.handle('updater:check', () => checkForUpdatesNow())
  // "Receive pre-release builds": persists, applies the flags, checks now.
  ipcMain.handle('updater:set-prerelease-updates', (_event, enabled: boolean) =>
    setPrereleaseUpdates(enabled === true)
  )
}
