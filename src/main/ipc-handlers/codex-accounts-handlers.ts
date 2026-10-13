import { BrowserWindow, ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'

/** The Codex account list, over IPC, from the same settings source the
 *  server answers from. No credential ever crosses: an account's `auth.json`
 *  is written by Codex's own login into the account's home and read by Codex
 *  alone; the renderer learns `hasCredential`. */
export function registerCodexAccountHandlers(): void {
  ipcMain.handle('codex-accounts:list', () => settings.codexAccounts.list())
  ipcMain.handle(
    'codex-accounts:add',
    (_event, input: { label: string; kind?: 'chatgpt' | 'apiKey' }) =>
      settings.codexAccounts.add(
        typeof input?.label === 'string' ? input.label : '',
        input?.kind === 'apiKey' ? 'apiKey' : 'chatgpt'
      )
  )
  ipcMain.handle('codex-accounts:update', (_event, id: string, updates: { label?: string }) =>
    settings.codexAccounts.rename(
      id,
      typeof updates?.label === 'string' ? updates.label : undefined
    )
  )
  ipcMain.handle('codex-accounts:reorder', (_event, ids: unknown) => {
    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
      return settings.codexAccounts.reorder(ids as string[])
    }
    return undefined
  })
  ipcMain.handle('codex-accounts:remove', (_event, id: string) => settings.codexAccounts.remove(id))
  ipcMain.handle('codex-accounts:clear-credential', (_event, id: string) =>
    settings.codexAccounts.clearCredential(id)
  )

  settings.subscribe((event) => {
    if (event._tag !== 'accounts.codex_changed') return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('codex-accounts:changed', event.accounts)
    }
  })
}
