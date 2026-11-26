import { ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'
import type { HelperPreferencePatch } from '../../shared/helper-preferences'
import type { DecisionPreferencePatch } from '../../shared/decision-preferences'

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
  // The decisions' switches (PRDCT-5179), the helpers' mirror on the same source.
  ipcMain.handle('decisions:list', () => settings.decisions.list())
  ipcMain.handle(
    'decisions:set',
    (_event, value: { decisionId: unknown; patch: DecisionPreferencePatch | undefined }) => {
      if (typeof value?.decisionId !== 'string') throw new Error('Invalid decision id')
      return settings.decisions.set(value.decisionId, value.patch ?? {})
    }
  )
}
