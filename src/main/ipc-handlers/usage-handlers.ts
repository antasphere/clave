import { BrowserWindow, ipcMain } from 'electron'
import { usageManager, type AccountUsageManager } from '../usage-manager'
import { codexUsageManager } from '../codex-usage'
import { piUsageManager, type PiUsageRange } from '../pi-usage'
import { claudeAccountsManager, DEFAULT_CLAUDE_ACCOUNT_ID } from '../claude-accounts'
import { codexAccountsManager, DEFAULT_CODEX_ACCOUNT_ID } from '../codex-accounts'
import { TEST_NO_ACTIVATE } from '../test-mode'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** One provider's channels: a read, the snapshot for a window that just
 *  opened, the push of every read, and the forgetting of removed accounts. */
function wireProvider(
  manager: AccountUsageManager,
  defaultId: string,
  channels: { get: string; snapshot: string; push: string },
  accounts: { onChange: (listener: () => void) => void; ids: () => string[] }
): void {
  // The account argument is optional so a caller written before accounts
  // existed (and the E2E fixtures that stub this channel) still reads the
  // machine's own login.
  ipcMain.handle(channels.get, (_event, accountId?: unknown, options?: { force?: boolean }) =>
    manager.getLimits(typeof accountId === 'string' && accountId ? accountId : defaultId, {
      force: options?.force === true
    })
  )
  ipcMain.handle(channels.snapshot, () => manager.snapshot())
  // Every read, polled or asked for, reaches every window: the foot of one
  // window and the settings page of another show the same number.
  manager.onUpdate((accountId, result) => broadcast(channels.push, { accountId, result }))
  accounts.onChange(() => {
    // A removed account's read must not outlive it in the cache.
    const live = new Set(accounts.ids())
    for (const id of Object.keys(manager.snapshot())) {
      if (!live.has(id)) manager.forget(id)
    }
  })
}

export function registerUsageHandlers(): void {
  wireProvider(
    usageManager,
    DEFAULT_CLAUDE_ACCOUNT_ID,
    { get: 'usage:get-limits', snapshot: 'usage:claude-snapshot', push: 'usage:claude-account' },
    {
      onChange: (listener) => claudeAccountsManager.onChange(listener),
      ids: () => claudeAccountsManager.list().map((a) => a.id)
    }
  )
  wireProvider(
    codexUsageManager,
    DEFAULT_CODEX_ACCOUNT_ID,
    {
      get: 'usage:get-codex-limits',
      snapshot: 'usage:codex-snapshot',
      push: 'usage:codex-account'
    },
    {
      onChange: (listener) => codexAccountsManager.onChange(listener),
      ids: () => codexAccountsManager.list().map((a) => a.id)
    }
  )
  ipcMain.handle('usage:get-pi', (_event, range: PiUsageRange) =>
    piUsageManager.get(['today', '7d', '30d', 'all'].includes(range) ? range : 'today')
  )

  // The five-minute clock, for every account of both providers. Not under
  // the E2E flag: a test instance stubs the channels above and must never
  // reach the keychain, the network or a codex binary on its own.
  if (!TEST_NO_ACTIVATE) {
    const anyWindow = (): boolean => BrowserWindow.getAllWindows().some((win) => !win.isDestroyed())
    usageManager.startPolling(undefined, anyWindow)
    codexUsageManager.startPolling(undefined, anyWindow)
  }
}
