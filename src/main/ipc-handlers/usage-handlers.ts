import { BrowserWindow, ipcMain } from 'electron'
import { usageManager } from '../usage-manager'
import { codexUsageManager } from '../codex-usage'
import { piUsageManager, type PiUsageRange } from '../pi-usage'
import { claudeAccountsManager, DEFAULT_CLAUDE_ACCOUNT_ID } from '../claude-accounts'
import { TEST_NO_ACTIVATE } from '../test-mode'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerUsageHandlers(): void {
  // The account argument is optional so a caller written before accounts
  // existed (and the E2E fixtures that stub this channel) still reads the
  // machine's own login.
  ipcMain.handle('usage:get-limits', (_event, accountId?: unknown, options?: { force?: boolean }) =>
    usageManager.getLimits(
      typeof accountId === 'string' && accountId ? accountId : DEFAULT_CLAUDE_ACCOUNT_ID,
      { force: options?.force === true }
    )
  )
  ipcMain.handle('usage:claude-snapshot', () => usageManager.snapshot())
  ipcMain.handle('usage:get-codex-limits', () => codexUsageManager.getLimits())
  ipcMain.handle('usage:get-pi', (_event, range: PiUsageRange) =>
    piUsageManager.get(['today', '7d', '30d', 'all'].includes(range) ? range : 'today')
  )

  // Every read, polled or asked for, reaches every window: the foot of one
  // window and the settings page of another show the same number.
  usageManager.onUpdate((accountId, result) =>
    broadcast('usage:claude-account', { accountId, result })
  )
  claudeAccountsManager.onChange(() => {
    // A removed account's read must not outlive it in the cache.
    const live = new Set(claudeAccountsManager.list().map((a) => a.id))
    for (const id of Object.keys(usageManager.snapshot())) {
      if (!live.has(id)) usageManager.forget(id)
    }
  })

  // The five-minute clock, for every account. Not under the E2E flag: a test
  // instance stubs the channel above and must never reach the keychain or the
  // network on its own.
  if (!TEST_NO_ACTIVATE) {
    usageManager.startPolling(undefined, () =>
      BrowserWindow.getAllWindows().some((win) => !win.isDestroyed())
    )
  }
}
