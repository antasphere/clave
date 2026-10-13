import { BrowserWindow, ipcMain } from 'electron'
import { usageManager } from '../usage-manager'
import { codexUsageManager } from '../codex-usage'
import { shellSettingsSource as settings } from '../settings/shell-source'
import { TEST_NO_ACTIVATE } from '../test-mode'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

const PI_RANGES = ['today', '7d', '30d', 'all'] as const
type PiRange = (typeof PI_RANGES)[number]

/** The usage reads over IPC, from the same settings source the server
 *  answers from: a read, the snapshot for a window that just opened, and the
 *  push of every read (polled or asked for) to every window, so the foot of
 *  one window and the settings page of another show the same number. */
export function registerUsageHandlers(): void {
  // The account argument is optional so a caller written before accounts
  // existed still reads the machine's own login.
  ipcMain.handle('usage:get-limits', (_event, accountId?: unknown, options?: { force?: boolean }) =>
    settings.usage.readClaude(
      typeof accountId === 'string' && accountId ? accountId : undefined,
      options?.force === true
    )
  )
  ipcMain.handle('usage:claude-snapshot', () => settings.usage.claudeSnapshot())
  ipcMain.handle(
    'usage:get-codex-limits',
    (_event, accountId?: unknown, options?: { force?: boolean }) =>
      settings.usage.readCodex(
        typeof accountId === 'string' && accountId ? accountId : undefined,
        options?.force === true
      )
  )
  ipcMain.handle('usage:codex-snapshot', () => settings.usage.codexSnapshot())
  ipcMain.handle('usage:get-pi', (_event, range: unknown) =>
    settings.usage.readPi(PI_RANGES.includes(range as PiRange) ? (range as PiRange) : 'today')
  )

  settings.subscribe((event) => {
    if (event._tag === 'usage.claude_read')
      broadcast('usage:claude-account', { accountId: event.accountId, result: event.result })
    else if (event._tag === 'usage.codex_read')
      broadcast('usage:codex-account', { accountId: event.accountId, result: event.result })
  })

  // The five-minute clock, for every account of both providers. Not under
  // the E2E flag: a test instance stubs the reads and must never reach the
  // keychain, the network or a codex binary on its own.
  if (!TEST_NO_ACTIVATE) {
    const anyWindow = (): boolean => BrowserWindow.getAllWindows().some((win) => !win.isDestroyed())
    usageManager.startPolling(undefined, anyWindow)
    codexUsageManager.startPolling(undefined, anyWindow)
  }
}
