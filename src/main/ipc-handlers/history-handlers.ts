import { ipcMain } from 'electron'
import {
  cancelSearch,
  getConversation,
  listHistory,
  searchHistory,
  stampHistory
} from '../session-history/service'
import {
  historyWithServers,
  restampSessionLaunch,
  searchServers,
  serverOwnerOf,
  stampRecords
} from '../session-history/host-reads'
import { SearchCancels, runHistorySearch } from '../session-history/history-search'
import { serverClient } from '../mcp/server-client'

/** The searches running now, and those cancelled while a server answered. */
const searchCancels = new SearchCancels()

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
  // PRDCT-4321: every connected server's History laid in, each row of a
  // server tagged with it; an offline server's last answer, kept.
  ipcMain.handle('history:list', async () => {
    let api: Awaited<ReturnType<typeof serverClient.api>> | null = null
    try {
      api = await serverClient.api()
    } catch {
      api = null
    }
    try {
      return await historyWithServers(api)
    } catch {
      return listHistory()
    }
  })
  // The message trail's read: a live tab's conversation as turns.
  ipcMain.handle('history:conversation', (_event, request: unknown) => getConversation(request))
  // This Mac's transcripts and each server's that holds one of the asked
  // conversations, searched at once (PRDCT-4321, `history-search.ts`).
  ipcMain.handle('history:search', (event, request: unknown) =>
    runHistorySearch(request, {
      searchLocal: searchHistory,
      searchServers,
      serverOwnerOf,
      send: (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('history:search-hits', progress)
      },
      cancels: searchCancels
    })
  )
  ipcMain.on('history:search-cancel', (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') return
    searchCancels.cancel(requestId)
    cancelSearch(requestId)
  })
}
