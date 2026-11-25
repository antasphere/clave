import { ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'
import type { WritingStyleDraft } from '../../shared/writing-styles'

/** The writing styles of this Mac over IPC (PRDCT-5166), from the same
 *  settings source the server answers from; the store validates the write.
 *  Every channel answers the whole view. */
export function registerWritingStyleHandlers(): void {
  ipcMain.handle('writing-styles:list', () => settings.writingStyles.list())
  ipcMain.handle('writing-styles:save', (_event, draft: WritingStyleDraft | undefined) => {
    if (typeof draft !== 'object' || draft === null) throw new Error('Invalid writing style')
    return settings.writingStyles.save(draft)
  })
  ipcMain.handle('writing-styles:delete', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid writing style id')
    return settings.writingStyles.remove(id)
  })
  ipcMain.handle('writing-styles:set-default', (_event, id: unknown) => {
    if (id !== null && typeof id !== 'string') throw new Error('Invalid writing style id')
    return settings.writingStyles.setDefault(id)
  })
  ipcMain.handle('writing-styles:import-claude', () => settings.writingStyles.importClaude())
}
