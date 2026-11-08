import * as fs from 'fs'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { openDialogs } from '../dialog-paths'
import {
  parseKeymapOverrides,
  resolveKeymapConfig,
  type KeymapOverridesV1,
  type ResolvedKeymapConfig
} from '../../../shared/src/keymaps'
import { getPreference, setPreference } from './clave-file-handlers'

export const KEYMAP_PREFERENCE_KEY = 'keymapOverrides'

export interface KeymapHandlerDeps {
  onChanged?: () => void
}

/** Read only a validated persisted value. A damaged or future-version file can
 * never replace the code defaults in the running app. */
export function getStoredKeymapOverrides(): KeymapOverridesV1 | null {
  const raw = getPreference(KEYMAP_PREFERENCE_KEY)
  if (raw === null) return null
  const parsed = parseKeymapOverrides(raw)
  if (!parsed.ok) {
    console.error('[keymaps] Ignoring invalid persisted configuration', parsed.errors)
    return null
  }
  return parsed.value
}

export function getStoredKeymapConfig(): ResolvedKeymapConfig {
  return resolveKeymapConfig(getStoredKeymapOverrides())
}

export function registerKeymapHandlers(deps: KeymapHandlerDeps = {}): void {
  ipcMain.handle('keymaps:load', () => getStoredKeymapOverrides())

  ipcMain.handle('keymaps:save', (_event, raw: unknown): KeymapOverridesV1 => {
    const parsed = parseKeymapOverrides(raw)
    if (!parsed.ok) {
      throw new Error(parsed.errors.map((error) => `${error.path}: ${error.message}`).join('\n'))
    }
    setPreference(KEYMAP_PREFERENCE_KEY, parsed.value)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('keymaps:changed', parsed.value)
    }
    deps.onChanged?.()
    return parsed.value
  })

  ipcMain.handle('keymaps:import', async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await openDialogs.open('keymap', window ?? undefined, {
      properties: ['openFile'],
      filters: [{ name: 'Clave keymaps', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return fs.readFileSync(result.filePaths[0], 'utf-8')
  })

  ipcMain.handle('keymaps:export', async (event, json: string): Promise<boolean> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: 'clave-keymaps.json',
      filters: [{ name: 'Clave keymaps', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    const temporaryPath = `${result.filePath}.tmp`
    fs.writeFileSync(temporaryPath, json, 'utf-8')
    fs.renameSync(temporaryPath, result.filePath)
    return true
  })
}
