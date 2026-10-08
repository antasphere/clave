import { BrowserWindow, ipcMain, shell } from 'electron'
import { shellSettingsSource as settings, shellAntasphereAccount } from '../settings/shell-source'
import { acceptedHandoff, handoffShape } from '../antasphere-handoff'

/**
 * The Antasphere account (PRDCT-3259) over IPC, from the same settings
 * source the server answers from (`settings/shell-source.ts`): the status,
 * in and out, and the four commands. The login itself is the server's; what
 * the shell adds is the one side effect a server has no business doing, the
 * user's own browser (`shell.openExternal`), opened on the handoff a sign-in
 * answered to the preload that asked, and on nothing else:
 *
 *  - the target is checked before it is opened: a URL at the issuer this
 *    process is configured for, and no other origin (the handoff came over
 *    the server's authenticated answer, and this is the shell's own check
 *    of what it is about to hand the system);
 *  - the handoff names a login generation and the exact URL issued for it,
 *    and the preload asks the manager that issued it, through the server,
 *    whether it is still the login in flight right before this open
 *    (`confirm-handoff` over IPC here, the server's command when attached):
 *    a cancel, a sign-out or a new login between the sign-in's answer and
 *    the open leaves a stale link that opens nothing. While the shell holds
 *    the manager (the server in-process) this handler asks it once more at
 *    the open itself; attached, the server's confirmation is the last word.
 *
 * The URL reaches no log and no window: the renderer gets the status.
 */
export function registerAntasphereAccountHandlers(): void {
  ipcMain.handle('antasphere-account:get', () => settings.antasphere.status())
  ipcMain.handle('antasphere-account:sign-in', () => settings.antasphere.signIn())
  ipcMain.handle('antasphere-account:confirm-handoff', (_event, handoff: unknown) => {
    const shape = handoffShape(handoff)
    return shape ? settings.antasphere.confirmHandoff(shape) : false
  })
  ipcMain.handle('antasphere-account:cancel', () => settings.antasphere.cancel())
  ipcMain.handle('antasphere-account:sign-out', () => settings.antasphere.signOut())
  ipcMain.handle('antasphere-account:dismiss', () => settings.antasphere.dismiss())
  ipcMain.handle('antasphere-account:open-browser', async (_event, handoff: unknown) => {
    const target = acceptedHandoff(handoff, process.env, shellAntasphereAccount)
    if (!target) {
      console.warn('[antasphere-account] a browser handoff was refused')
      return
    }
    await shell.openExternal(target.toString())
  })

  settings.subscribe((event) => {
    if (event._tag !== 'accounts.antasphere_changed') return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('antasphere-account:changed', event.status)
    }
  })
  // The stored session is read back here, after `app` is ready (safeStorage
  // cannot be asked before) and once the fan-out above is in place, so the
  // first window to ask gets the restored login, or hears it land. A state,
  // never a rejection: a login is never what stops Clave from starting.
  shellAntasphereAccount?.restore().catch((err: unknown) => {
    console.error('[antasphere-account] restore failed:', err instanceof Error ? err.name : err)
  })
}
