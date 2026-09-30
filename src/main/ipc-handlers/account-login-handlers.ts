import { BrowserWindow, ipcMain } from 'electron'
import { accountLoginManager, type LoginJob } from '../account-login'

function broadcast(job: LoginJob): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('accounts:login-progress', job)
  }
}

/** The login flows of ADR 0002. A job crosses as its status, link and
 *  reason; the credential it captures never does. */
export function registerAccountLoginHandlers(): void {
  ipcMain.handle('accounts:login-start', (_event, provider: unknown, accountId: unknown) => {
    if (typeof accountId !== 'string') throw new Error('No account')
    if (provider === 'claude') return accountLoginManager.startClaudeLogin(accountId)
    if (provider === 'codex') return accountLoginManager.startCodexLogin(accountId)
    throw new Error('Unknown provider')
  })
  ipcMain.handle('accounts:login-api-key', (_event, accountId: unknown, apiKey: unknown) => {
    if (typeof accountId !== 'string' || typeof apiKey !== 'string') throw new Error('No account')
    return accountLoginManager.startCodexApiKeyLogin(accountId, apiKey)
  })
  ipcMain.handle('accounts:login-input', (_event, jobId: unknown, text: unknown) => {
    if (typeof jobId === 'string' && typeof text === 'string') {
      accountLoginManager.sendInput(jobId, text)
    }
  })
  ipcMain.handle('accounts:login-cancel', (_event, jobId: unknown) => {
    if (typeof jobId === 'string') accountLoginManager.cancel(jobId)
  })
  ipcMain.handle('accounts:login-list', () => accountLoginManager.list())
  accountLoginManager.onProgress(broadcast)
}
