import { BrowserWindow, ipcMain } from 'electron'
import { TRIAGE_IPC } from '../../shared/triage'
import { triagePrepare, triageSnapshot } from '../triage'

/** "Debug Clave…" (issue #227): the snapshot and the bundle, over IPC only.
 *  The asking window is the triage's origin. */
export function registerTriageHandlers(): void {
  ipcMain.handle(TRIAGE_IPC.prepare, (event) =>
    triagePrepare(BrowserWindow.fromWebContents(event.sender))
  )
  ipcMain.handle(TRIAGE_IPC.snapshot, (event) =>
    triageSnapshot(BrowserWindow.fromWebContents(event.sender))
  )
}
