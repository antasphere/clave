import { ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'

/** This Mac's models catalogue over IPC (PRDCT-4496), from the same settings
 *  source the server answers from: the providers of those ids in their
 *  order, every one when none is named. Only the two known fields go on. */
export function registerModelsCatalogHandlers(): void {
  ipcMain.handle('models-catalog:read', (_event, input: unknown) => {
    const value = (typeof input === 'object' && input !== null ? input : {}) as {
      providerIds?: unknown
      force?: unknown
    }
    const providerIds = Array.isArray(value.providerIds)
      ? value.providerIds.filter((id): id is string => typeof id === 'string')
      : undefined
    return settings.modelsCatalog.read({
      ...(providerIds && { providerIds }),
      ...(value.force === true && { force: true })
    })
  })
}
