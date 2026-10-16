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

/** Where the server is, for the preload's router: null until the shell has
 *  started it, and the router then keeps every method on IPC. IPC is the one
 *  way the address reaches a window. The moment a server is named, every
 *  window is told so and asks again (PRDCT-3527). */
export function registerServerHandlers(): void {
  ipcMain.handle(IPC_SERVER_ENDPOINT, () => getClaveServerEndpoint())
  ipcMain.handle(IPC_SERVER_EXTERNAL, () => isServerExternal())
  onClaveServerEndpointNamed(() => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(IPC_SERVER_ENDPOINT_NAMED)
  })
}
