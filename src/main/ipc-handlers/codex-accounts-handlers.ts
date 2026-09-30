import { BrowserWindow, ipcMain } from 'electron'
import { codexAccountsManager } from '../codex-accounts'
import { codexUsageManager } from '../codex-usage'

/** The Codex account list. No credential ever crosses: an account's
 *  `auth.json` is written by Codex's own login into the account's home and
 *  read by Codex alone; the renderer learns `hasCredential`. */
export function registerCodexAccountHandlers(): void {
  ipcMain.handle('codex-accounts:list', () => codexAccountsManager.list())
  ipcMain.handle(
    'codex-accounts:add',
    (_event, input: { label: string; kind?: 'chatgpt' | 'apiKey' }) =>
      codexAccountsManager.add({
        label: typeof input?.label === 'string' ? input.label : '',
        kind: input?.kind === 'apiKey' ? 'apiKey' : 'chatgpt'
      })
  )
  ipcMain.handle('codex-accounts:update', (_event, id: string, updates: { label?: string }) =>
    codexAccountsManager.update(id, {
      ...(typeof updates?.label === 'string' ? { label: updates.label } : {})
    })
  )
  ipcMain.handle('codex-accounts:reorder', (_event, ids: unknown) => {
    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
      codexAccountsManager.reorder(ids as string[])
    }
  })
  ipcMain.handle('codex-accounts:remove', (_event, id: string) => {
    const removed = codexAccountsManager.remove(id)
    if (removed) codexUsageManager.forget(id)
    return removed
  })
  ipcMain.handle('codex-accounts:clear-credential', (_event, id: string) => {
    codexAccountsManager.clearCredential(id)
    codexUsageManager.forget(id)
  })

  codexAccountsManager.onChange((accounts) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('codex-accounts:changed', accounts)
    }
  })
}
