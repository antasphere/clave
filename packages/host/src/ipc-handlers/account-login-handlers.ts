import { BrowserWindow, ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'

/** The login flows of ADR 0002, over IPC, from the same settings source the
 *  server answers from. A job crosses as its status, link and reason; the
 *  credential it captures never does. */
export function registerAccountLoginHandlers(): void {
  ipcMain.handle('accounts:login-start', (_event, provider: unknown, accountId: unknown) => {
    if (typeof accountId !== 'string') throw new Error('No account')
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider')
    return settings.logins.start(provider, accountId)
  })
  ipcMain.handle('accounts:login-api-key', (_event, accountId: unknown, apiKey: unknown) => {
    if (typeof accountId !== 'string' || typeof apiKey !== 'string') throw new Error('No account')
    return settings.logins.startApiKey(accountId, apiKey)
  })
  ipcMain.handle('accounts:login-input', (_event, jobId: unknown, text: unknown) => {
    if (typeof jobId === 'string' && typeof text === 'string') {
      return settings.logins.input(jobId, text)
    }
    return undefined
  })
  ipcMain.handle('accounts:login-cancel', (_event, jobId: unknown) => {
    if (typeof jobId === 'string') return settings.logins.cancel(jobId)
    return undefined
  })
  ipcMain.handle('accounts:login-list', () => settings.logins.list())

  settings.subscribe((event) => {
    if (event._tag !== 'accounts.login_progressed') return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('accounts:login-progress', event.job)
    }
  })
}
