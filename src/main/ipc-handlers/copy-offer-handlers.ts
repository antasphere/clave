import { clipboard, ipcMain } from 'electron'
import {
  listOfferViews,
  copyOfferToClipboard,
  dismissOffer,
  dismissSessionOffers,
  installCopyOfferShell
} from '../copy-offer-manager'
import { broadcastToAllWindows } from '../window-routing'

export function registerCopyOfferHandlers(): void {
  // The store's clipboard and windows are the shell's (PRDCT-3293): named
  // here, once, so the store itself imports no Electron.
  installCopyOfferShell({
    writeClipboard: (text) => clipboard.writeText(text),
    broadcast: (views) => broadcastToAllWindows('copy-offer:changed', views)
  })
  ipcMain.handle('copy-offer:list', () => listOfferViews())
  ipcMain.handle('copy-offer:copy', (_event, id: string) => copyOfferToClipboard(id))
  ipcMain.handle('copy-offer:dismiss', (_event, id: string) => dismissOffer(id))
  ipcMain.handle('copy-offer:dismiss-session', (_event, sessionId: string) =>
    dismissSessionOffers(sessionId)
  )
}
