import { ipcMain, BrowserWindow } from 'electron'
import type { WindowLayout } from '@clave/contract/sidebar'
import { windowRegistry } from '../window-registry'
import { sidebarLayouts, sidebarTransport } from '../sidebar-layouts'

/**
 * The sidebar over IPC: the same domain the server answers for over its
 * API (`src/main/sidebar-layouts.ts`), reached directly by a window that
 * has no server yet or whose server runs elsewhere. A renderer loads and
 * saves ITS OWN layout, resolved from the sender; it never names a window
 * key. The primary's load also takes in the orphans (the layouts of windows
 * that no longer exist), which the domain decides through its host.
 */
export function registerSidebarLayoutHandlers(): void {
  const keyOf = (event: Electron.IpcMainInvokeEvent): string | null => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? windowRegistry.getKeyForWindow(win.id) : null
  }

  ipcMain.handle('sidebar:transport', () => sidebarTransport())

  ipcMain.handle('sidebar-layout:load', (event) => {
    const key = keyOf(event)
    if (!key) return { windowKey: '', revision: 0, groups: [], displayOrder: [] }
    return sidebarLayouts().get(key)
  })

  ipcMain.handle('sidebar-layout:save', (event, data: WindowLayout, baseRevision?: unknown) => {
    const key = keyOf(event)
    if (!key) {
      console.error('[sidebar-layout] refused: save from an unknown window')
      return { ok: false as const, reason: 'no-window' as const }
    }
    const result = sidebarLayouts().save(
      key,
      data,
      typeof baseRevision === 'number' ? baseRevision : undefined
    )
    if (result.ok) return { ok: true as const, layout: result.value }
    return { ok: false as const, reason: 'conflict' as const, current: result.error.current }
  })
}
