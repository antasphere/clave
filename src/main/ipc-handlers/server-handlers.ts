import { ipcMain } from 'electron'
import { IPC_SERVER_ENDPOINT } from '@clave/contract/env'
import { getClaveServerEndpoint } from '../server/endpoint'

/** Where the server is, for the preload's router: null until the shell has
 *  started it, and the router then keeps every method on IPC. IPC is the one
 *  way the address reaches a window. */
export function registerServerHandlers(): void {
  ipcMain.handle(IPC_SERVER_ENDPOINT, () => getClaveServerEndpoint())
}
