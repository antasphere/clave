import { BrowserWindow, ipcMain } from 'electron'
import {
  PAIRING_IPC,
  type ServerPairingChange,
  type ServerPairings
} from '../../../packages/contract/src/fleet'
import { settingsPorts } from '../ports/registry'
import { ServerPairingRegistry } from '../server-connections/pairings'

let shared: ServerPairingRegistry | undefined
/** The paired workspaces of this Mac, one instance for main. Lazy: the boot
 *  may register IPC before userData is ready. */
export function serverPairingRegistry(): ServerPairingRegistry {
  return (shared ??= new ServerPairingRegistry(settingsPorts()))
}

/** The pairings over IPC (PRDCT-4151): a window reads them at boot, changes
 *  them from a proposal or from Settings, and every window hears each change
 *  as the whole state, so two windows on the same Mac agree. */
export function registerServerPairingHandlers(registry?: ServerPairingRegistry): void {
  if (registry) shared = registry
  const broadcast = (state: ServerPairings): void => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(PAIRING_IPC.changed, state)
  }
  ipcMain.handle(PAIRING_IPC.load, () => serverPairingRegistry().load())
  ipcMain.handle(PAIRING_IPC.change, (_event, change: ServerPairingChange) => {
    const next = serverPairingRegistry().change(change)
    broadcast(next)
    return next
  })
}
