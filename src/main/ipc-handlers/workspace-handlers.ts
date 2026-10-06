import { BrowserWindow, ipcMain } from 'electron'
import { windowRegistry } from '../window-registry'
import { shellSettingsSource as settings } from '../settings/shell-source'

/** The window key of the renderer that asked, so the change event names it
 *  as the writer and it is skipped on the way back: it already has the
 *  state, and sending it back would race its next mutation. */
function originOf(sender: Electron.WebContents): string | undefined {
  const win = BrowserWindow.fromWebContents(sender)
  return (win && windowRegistry.getKeyForWindow(win.id)) ?? undefined
}

/** The workspace state file over IPC, written field by field through the
 *  same settings source the server writes it through: the renderer owns the
 *  state during a run and persists every mutation through the channel for
 *  the field it changed; main keeps a synchronous cache so the PTY layer can
 *  stamp spawns without an async hop. Registry and pin changes reach every
 *  OTHER window, which folds them into its stores (registry and pins only,
 *  never groups or sessions). */
export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:load', () => settings.workspaces.load())

  ipcMain.handle('workspace:update-registry', (event, workspaces: unknown) =>
    settings.workspaces.updateRegistry(workspaces as never, originOf(event.sender))
  )

  ipcMain.handle('workspace:update-pins', (event, scope: unknown, pins: unknown) =>
    settings.workspaces.updatePins(scope as never, pins as never, originOf(event.sender))
  )

  ipcMain.handle('workspace:set-last-active', async (_event, workspaceId: unknown) => {
    await settings.workspaces.setLastActive(workspaceId as never)
    return { ok: true as const }
  })

  settings.subscribe((event) => {
    if (event._tag !== 'workspaces.state_changed') return
    const { workspaces, pins, origin } = event
    for (const win of windowRegistry.listWindows()) {
      if (origin !== null && windowRegistry.getKeyForWindow(win.id) === origin) continue
      win.webContents.send('workspace:state-changed', { workspaces, pins })
    }
  })
}
