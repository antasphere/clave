import { ipcMain } from 'electron'
import { getClaveServerEndpoint } from '../server/endpoint'

/** Where the server is, for the preload's router: null until the shell has
 *  started it, and the router then keeps every method on IPC. */
export function registerServerHandlers(): void {
  ipcMain.handle('server:endpoint', () => getClaveServerEndpoint())
}
