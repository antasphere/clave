import { BrowserWindow, ipcMain } from 'electron'
import { claudeAccountsManager } from '../claude-accounts'
import { usageManager } from '../usage-manager'

/** The account list and its tokens. A token goes IN through here and never
 *  comes out: the renderer learns `hasToken` and the usage read that proves
 *  the token, nothing more. */
export function registerClaudeAccountHandlers(): void {
  ipcMain.handle('claude-accounts:list', () => claudeAccountsManager.list())
  ipcMain.handle('claude-accounts:migrated', () => claudeAccountsManager.migratedAccountIds())
  ipcMain.handle('claude-accounts:add', (_event, input: { label: string }) =>
    claudeAccountsManager.add({ label: typeof input?.label === 'string' ? input.label : '' })
  )
  ipcMain.handle('claude-accounts:update', (_event, id: string, updates: { label?: string }) =>
    claudeAccountsManager.update(id, {
      ...(typeof updates?.label === 'string' ? { label: updates.label } : {})
    })
  )
  ipcMain.handle('claude-accounts:reorder', (_event, ids: unknown) => {
    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
      claudeAccountsManager.reorder(ids as string[])
    }
  })
  ipcMain.handle('claude-accounts:remove', (_event, id: string) => claudeAccountsManager.remove(id))
  // Storing the token and reading the account's limits with it are one call:
  // the read is what tells the user the paste worked.
  ipcMain.handle('claude-accounts:set-token', async (_event, id: string, token: string) => {
    claudeAccountsManager.setToken(id, typeof token === 'string' ? token : '')
    return usageManager.getLimits(id, { force: true })
  })
  ipcMain.handle('claude-accounts:clear-token', (_event, id: string) => {
    claudeAccountsManager.clearToken(id)
    usageManager.forget(id)
  })

  claudeAccountsManager.onChange((accounts) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('claude-accounts:changed', accounts)
    }
  })
}
