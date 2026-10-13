import { ipcMain } from 'electron'
import { queryActivity, startActivityRecord, type ActivityQuery } from '../activity/service'

/** The activity record (PRDCT-3384, PRDCT-3385): recording starts with the
 *  handlers, before any session is adopted; the windows read the fold. */
export function registerActivityHandlers(): void {
  startActivityRecord()
  ipcMain.handle('activity:query', (_event, query: ActivityQuery) => queryActivity(query))
}
