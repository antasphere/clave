import { ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'
import type { HelperPreferencePatch } from '../../shared/helper-preferences'

/** The helpers' preference of this Mac over IPC (PRDCT-4330), from the same
 *  settings source the server answers from; the store validates the write. */
export function registerHelperHandlers(): void {
  ipcMain.handle('helpers:list', () => settings.helpers.list())
  ipcMain.handle(
    'helpers:set',
    (_event, value: { helperId: unknown; patch: HelperPreferencePatch | undefined }) => {
      if (typeof value?.helperId !== 'string') throw new Error('Invalid helper id')
      return settings.helpers.set(value.helperId, value.patch ?? {})
    }
  )
}
