import { ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'

/** A stored provider connection's usage line over IPC (PRDCT-4496), from the
 *  same settings source the server answers from. Only the two known fields go
 *  on; an id that is not a string is the unknown line, never a throw. */
export function registerProviderUsageHandlers(): void {
  ipcMain.handle('provider-usage:read', (_event, input: unknown) => {
    const value = (typeof input === 'object' && input !== null ? input : {}) as {
      connectionId?: unknown
      force?: unknown
    }
    if (typeof value.connectionId !== 'string')
      return { kind: 'unknown' as const, reason: 'The connection is not known here.' }
    return settings.providerUsage.read({
      connectionId: value.connectionId,
      ...(value.force === true && { force: true })
    })
  })
}
