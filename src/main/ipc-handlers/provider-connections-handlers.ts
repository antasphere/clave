import { BrowserWindow, ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'
import { HARNESS_BY_ID } from '../../shared/harness'
import { harnessProviderConnections } from '../../shared/provider-connection-pick'
import { piStartModels } from '../mcp/provider-launch-listing'
import { modelsCatalog } from '../models-catalog'
import { piOwnDefault } from '../provider-injection-spawn'
import type { ProviderConnectionView } from '@clave/contract/settings/connections'

/** A connection view as the window passes it: what the Pi rule reads of one
 *  (its id, label, company, endpoints and whether it has a key). Never a key. */
function isConnectionView(value: unknown): value is ProviderConnectionView {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.label === 'string' &&
    typeof v.company === 'string' &&
    Array.isArray(v.endpoints) &&
    v.endpoints.every(
      (e) =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as Record<string, unknown>).wireFormat === 'string'
    )
  )
}

/** The provider connections and their keys, over IPC (PRDCT-4426): the same
 *  settings source the server answers from (`settings/shell-source.ts`), so a
 *  window on either route reads one list. A key goes IN through here and
 *  never comes out: the renderer learns `hasKey`, nothing more. */
export function registerProviderConnectionsHandlers(): void {
  ipcMain.handle('provider-connections:list', () => settings.providerConnections.list())
  // What each Pi connection starts on when an open names no model, by id
  // (PRDCT-4496): the spawn's own rule, for the window's clave_launch_options.
  // The person's Pi default is read here, on the machine whose Pi runs. The
  // window passes the connections it lists: with the server as a separate
  // process (the packaged default) they are that server's, and this
  // process's own store holds none of them.
  ipcMain.handle('provider-connections:pi-start-models', async (_event, listed: unknown) =>
    Object.fromEntries(
      await piStartModels(
        harnessProviderConnections(
          HARNESS_BY_ID.pi,
          Array.isArray(listed)
            ? listed.filter(isConnectionView)
            : [...(await settings.providerConnections.list())]
        ),
        {
          catalog: (providerIds) => modelsCatalog.view({ providerIds }),
          piOwnDefault: () => piOwnDefault()
        }
      )
    )
  )
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
