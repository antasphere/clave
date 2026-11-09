import { ipcMain } from 'electron'
import {
  cancelSearch,
  getConversation,
  listHistory,
  restampLaunch,
  searchHistory,
  stampHistory,
  type StampRecordSource
} from '../session-history/service'
import { ptyManager } from '../pty-manager'
import { isServerExternal } from '../server/endpoint'
import { serverClient } from '../mcp/server-client'
import { recordsWithStopped } from '../mcp/conversation-history'
import { overlayLiveLaunch } from '../session-history/live-launch'

/** The session's record for a ledger row's launch (PRDCT-4236): main's own,
 *  else, when the sessions live on a server of their own, the server's. */
const stampRecords: StampRecordSource = {
  local: (sessionId) => ptyManager.getSessionRecord(sessionId),
  remote: async (sessionId) => {
    if (!isServerExternal()) return null
    const records = await (await serverClient.api()).sessions.listAdoptable([sessionId])
    return records.find((r) => r.id === sessionId) ?? null
  }
}

/** The ledger told what a tab runs on before its record goes (PRDCT-4236,
 *  round 6): main's record, else the server's. Never throws: a close must
 *  not wait on, or fail because of, the History. */
export async function restampSessionLaunch(sessionId: string): Promise<void> {
  try {
    const record = stampRecords.local(sessionId) ?? (await stampRecords.remote?.(sessionId)) ?? null
    if (record) restampLaunch(sessionId, record as Parameters<typeof restampLaunch>[1])
  } catch (err) {
    console.error('[session-history] failed to restamp the launch', err)
  }
}

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
    const listed = listHistory()
    try {
      const api = await serverClient.api()
      const records = await recordsWithStopped(
        (ids) => api.sessions.listAdoptable(ids),
        () => api.sessions.list()
      )
      return { ...listed, entries: overlayLiveLaunch(listed.entries, records) }
    } catch {
      return listed
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
