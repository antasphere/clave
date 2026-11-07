import { BrowserWindow, ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'

/** The account list and its tokens, over IPC: the same settings source the
 *  server answers from (`settings/shell-source.ts`), so a window on either
 *  route reads one list. A token goes IN through here and never comes out:
 *  the renderer learns `hasToken` and the usage read that proves the token,
 *  nothing more. */
export function registerClaudeAccountHandlers(): void {
  ipcMain.handle('claude-accounts:list', () => settings.claudeAccounts.list())
  ipcMain.handle('claude-accounts:migrated', () => settings.claudeAccounts.migrated())
  ipcMain.handle('claude-accounts:add', (_event, input: { label: string }) =>
    settings.claudeAccounts.add(typeof input?.label === 'string' ? input.label : '')
  )
  ipcMain.handle('claude-accounts:update', (_event, id: string, updates: { label?: string }) =>
    settings.claudeAccounts.rename(
      id,
      typeof updates?.label === 'string' ? updates.label : undefined
    )
  )
  ipcMain.handle('claude-accounts:reorder', (_event, ids: unknown) => {
    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
      return settings.claudeAccounts.reorder(ids as string[])
    }
    return undefined
  })
  ipcMain.handle('claude-accounts:remove', (_event, id: string) =>
    settings.claudeAccounts.remove(id)
  )
  // Storing the token and reading the account's limits with it are one call:
  // the read is what tells the user the paste worked.
  ipcMain.handle('claude-accounts:set-token', (_event, id: string, token: string) =>
    settings.claudeAccounts.setToken(id, typeof token === 'string' ? token : '')
  )
  ipcMain.handle('claude-accounts:clear-token', (_event, id: string) =>
    settings.claudeAccounts.clearToken(id)
  )

  settings.subscribe((event) => {
    if (event._tag !== 'accounts.claude_changed') return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('claude-accounts:changed', event.accounts)
    }
  })
}
