import { BrowserWindow, ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'

/** The provider connections and their keys, over IPC (PRDCT-4426): the same
 *  settings source the server answers from (`settings/shell-source.ts`), so a
 *  window on either route reads one list. A key goes IN through here and
 *  never comes out: the renderer learns `hasKey`, nothing more. */
export function registerProviderConnectionsHandlers(): void {
  ipcMain.handle('provider-connections:list', () => settings.providerConnections.list())
  ipcMain.handle('provider-connections:add', (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Pick a provider first.')
    const { company, label, baseUrl, wireFormat } = input as Record<string, unknown>
    if (typeof company !== 'string') throw new Error('Pick a provider first.')
    // The source's manager refuses a company or a wire format it does not know.
    return settings.providerConnections.add({
      company: company as Parameters<typeof settings.providerConnections.add>[0]['company'],
      ...(typeof label === 'string' && { label }),
      ...(typeof baseUrl === 'string' && { baseUrl }),
      ...(typeof wireFormat === 'string' && {
        wireFormat: wireFormat as Parameters<
          typeof settings.providerConnections.add
        >[0]['wireFormat']
      })
    })
  })
  ipcMain.handle('provider-connections:rename', (_event, id: unknown, label: unknown) =>
    settings.providerConnections.rename(
      typeof id === 'string' ? id : '',
      typeof label === 'string' ? label : ''
    )
  )
  ipcMain.handle('provider-connections:remove', (_event, id: unknown) =>
    settings.providerConnections.remove(typeof id === 'string' ? id : '')
  )
  ipcMain.handle('provider-connections:set-key', (_event, id: unknown, apiKey: unknown) => {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Paste the key first.')
    return settings.providerConnections.setKey(typeof id === 'string' ? id : '', apiKey)
  })

  settings.subscribe((event) => {
    if (event._tag !== 'accounts.providers_changed') return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed())
        win.webContents.send('provider-connections:changed', event.connections)
    }
  })
}
