import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { openDialogs } from '../dialog-paths'
import { join } from 'path'
import { LinkedDocumentStore } from './store'
import { broadcastToAllWindows } from '../window-routing'
import { windowRegistry } from '../window-registry'
import { TEST_NO_ACTIVATE } from '../test-mode'
import type { LinkedOpen, LinkedUpdate } from '../../shared/linked-documents'
let store: LinkedDocumentStore | undefined
export function linkedDocuments(): LinkedDocumentStore {
  return (store ??= new LinkedDocumentStore(join(app.getPath('userData'), 'linked-documents'), () =>
    broadcastToAllWindows('linked-documents:changed')
  ))
}
export function registerLinkedDocumentHandlers(): void {
  function own(event: Electron.IpcMainInvokeEvent, sessionId: string): void {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || windowRegistry.getWindowForSession(sessionId)?.id !== window.id)
      throw new Error('Session belongs to another window')
  }
  ipcMain.handle('linked-documents:get-default-signature', () =>
    linkedDocuments().getDefaultSignature()
  )
  ipcMain.handle('linked-documents:set-default-signature', (_event, path: string) => {
    if (typeof path !== 'string') throw new Error('Expected signature file path')
    return linkedDocuments().setDefaultSignature(path)
  })
  ipcMain.handle('linked-documents:list', (event) =>
    linkedDocuments()
      .list()
      .filter(
        (d) => windowRegistry.getWindowForSession(d.sessionId)?.webContents.id === event.sender.id
      )
  )
  ipcMain.handle('linked-documents:open', (event, sessionId: string, input: LinkedOpen) => {
    own(event, sessionId)
    return linkedDocuments().open(sessionId, input)
  })
  ipcMain.handle(
    'linked-documents:update',
    async (event, id: string, revision: number, input: LinkedUpdate) => {
      own(event, linkedDocuments().get(id).sessionId)
      // A test instance may hold the watcher's reload to open the window in
      // which a keystroke crosses it (the end-to-end spec of PRDCT-4261).
      if (TEST_NO_ACTIVATE && input?.reloadExternal && input.ifChanged) {
        const hold = Number(process.env.CLAVE_TEST_LINKED_RELOAD_HOLD_MS)
        if (hold > 0) await new Promise((r) => setTimeout(r, hold))
      }
      return linkedDocuments().update(id, revision, input)
    }
  )
  ipcMain.handle(
    'linked-documents:open-attachment',
    async (event, id: string, attachmentId: string) => {
      own(event, linkedDocuments().get(id).sessionId)
      const error = await shell.openPath(linkedDocuments().attachmentPath(id, attachmentId))
      if (error) throw new Error(error)
    }
  )
  ipcMain.handle('linked-documents:choose-files', async (event, signature: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('Window unavailable')
    const result = await openDialogs.open('document', win, {
      properties: signature ? ['openFile'] : ['openFile', 'multiSelections'],
      ...(signature ? { filters: [{ name: 'HTML signature', extensions: ['html', 'htm'] }] } : {})
    })
    return result.filePaths
  })
}
