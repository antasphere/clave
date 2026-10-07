import { ipcMain, BrowserWindow } from 'electron'
import type { WindowLayout } from '@clave/contract/sidebar'
import { windowRegistry } from '../window-registry'
import { sidebarLayouts, sidebarTransport } from '../sidebar-layouts'
import { TEST_NO_ACTIVATE } from '../test-mode'

/** The end-to-end suite's seam, under --test-no-activate only: how many
 *  sidebar calls came over IPC, so a spec can tell the server's road from
 *  the shell's (`globalThis.__claveE2E.sidebarIpc`). */
function countIpc(kind: 'load' | 'save'): void {
  if (!TEST_NO_ACTIVATE) return
  const g = globalThis as typeof globalThis & {
    __claveE2E?: { sidebarIpc?: { load: number; save: number } }
  }
  const counts = (g.__claveE2E ??= {}).sidebarIpc ?? { load: 0, save: 0 }
  counts[kind] += 1
  g.__claveE2E.sidebarIpc = counts
}

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
    countIpc('load')
    const key = keyOf(event)
    if (!key) return { windowKey: '', revision: 0, groups: [], displayOrder: [] }
    return sidebarLayouts().get(key)
  })

  ipcMain.handle('sidebar-layout:save', (event, data: WindowLayout, baseRevision?: unknown) => {
    countIpc('save')
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
