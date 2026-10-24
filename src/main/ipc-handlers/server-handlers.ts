import { BrowserWindow, ipcMain } from 'electron'
import {
  IPC_SERVER_ENDPOINT,
  IPC_SERVER_ENDPOINT_NAMED,
  IPC_SERVER_EXTERNAL
} from '@clave/contract/env'
import {
  getClaveServerEndpoint,
  isServerExternal,
  onClaveServerEndpointNamed
} from '../server/endpoint'
import { FLEET_IPC, type SaveServerConnection } from '../../../packages/contract/src/fleet'
import { settingsPorts } from '../ports/registry'
import { ServerConnectionRegistry } from '../server-connections/registry'

/** Where the server is, for the preload's router: null until the shell has
 *  started it, and the router then keeps every method on IPC. IPC is the one
 *  way the address reaches a window. The moment a server is named, every
 *  window is told so and asks again (PRDCT-3527). */
export function registerServerHandlers(registry?: ServerConnectionRegistry): void {
  ipcMain.handle(IPC_SERVER_ENDPOINT, () => getClaveServerEndpoint())
  ipcMain.handle(IPC_SERVER_EXTERNAL, () => isServerExternal())
  onClaveServerEndpointNamed(() => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(IPC_SERVER_ENDPOINT_NAMED)
  })
  // Lazy: the boot may register IPC before safeStorage and userData are ready.
  const connections = (): ServerConnectionRegistry =>
    (registry ??= new ServerConnectionRegistry(settingsPorts()))
  const changed = (): void => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(FLEET_IPC.changed)
  }
  ipcMain.handle(FLEET_IPC.list, () => connections().list())
  ipcMain.handle(FLEET_IPC.save, (_event, input: SaveServerConnection) => {
    const result = connections().save(input)
    changed()
    return result
  })
  ipcMain.handle(FLEET_IPC.connect, (_event, id: string) => {
    const result = connections().connect(id)
    changed()
    return result
  })
  ipcMain.handle(FLEET_IPC.disconnect, (_event, id: string) => {
    const result = connections().disconnect(id)
    changed()
    return result
  })
  ipcMain.handle(FLEET_IPC.remove, (_event, id: string) => {
    connections().remove(id)
    changed()
  })
  // Privileged preload only. E must not bridge this channel to renderer.
  ipcMain.handle(FLEET_IPC.endpoint, (_event, id: string) => connections().endpoint(id))
}
