import { ipcMain } from 'electron'
import { listRequests, submitSecret, dismissRequest } from '../secret-request-manager'

export function registerSecretHandlers(): void {
  ipcMain.handle('secret:list', () => listRequests())
  ipcMain.handle('secret:submit', (_event, id: string, secret: string) => submitSecret(id, secret))
  ipcMain.handle('secret:dismiss', (_event, id: string) => dismissRequest(id))
}
