import { ipcMain } from 'electron'
import {
  cancelSearch,
  getConversation,
  listHistory,
  searchHistory,
  stampHistory
} from '../session-history/service'
import {
  historyWithLiveLaunch,
  restampSessionLaunch,
  stampRecords
} from '../session-history/host-reads'
import { serverClient } from '../mcp/server-client'

/** Session-history IPC (PRDCT-1738). `history:stamp` is fire-and-forget
 *  (`send`, not `invoke`): the renderer writes a ledger row whenever a tab's
 *  placement changes and must never wait on, or fail because of, the disk.
 *  `history:list` is the dialog's one read. `history:search` streams hits
 *  back to the ASKING window (`history:search-hits`) and resolves with the
 *  totals; `history:search-cancel` aborts between lines. */
export function registerHistoryHandlers(): void {
  ipcMain.on('history:stamp', (_event, row: unknown) => {
    void stampHistory(row, stampRecords)
  })
  // The renderer's close, before the kill: the tab's launch as it runs now.
  ipcMain.handle('history:restamp', (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? restampSessionLaunch(sessionId) : Promise.resolve()
  )
  // The dialog's read: the ledger's memory, the live record of every tab that
  // still holds a conversation laid over it (round 5 F1 of PRDCT-4236); a
  // host that cannot list its records answers the ledger alone.
  ipcMain.handle('history:list', async () => {
    try {
      return await historyWithLiveLaunch(await serverClient.api())
    } catch {
      return listHistory()
    }
  })
  // The message trail's read: a live tab's conversation as turns.
  ipcMain.handle('history:conversation', (_event, request: unknown) => getConversation(request))
  ipcMain.handle('history:search', (event, request: unknown) =>
    searchHistory(request, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('history:search-hits', progress)
    })
  )
  ipcMain.on('history:search-cancel', (_event, requestId: unknown) => {
    if (typeof requestId === 'string') cancelSearch(requestId)
  })
}
