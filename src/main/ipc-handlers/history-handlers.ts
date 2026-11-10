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
import { splitSearchIds } from '../session-history/fleet-history'
import type { HistorySearchScope } from '@clave/contract/history'
import { serverClient } from '../mcp/server-client'

/** Session-history IPC (PRDCT-1738). `history:stamp` is fire-and-forget
 *  (`send`, not `invoke`): the renderer writes a ledger row whenever a tab's
 *  placement changes and must never wait on, or fail because of, the disk.
 *  `history:list` is the dialog's one read. `history:search` streams hits
 *  back to the ASKING window (`history:search-hits`) and resolves with the
 *  totals; `history:search-cancel` aborts between lines. */
const SERVER_SCOPES: ReadonlySet<string> = new Set(['human', 'agent', 'tools'])
/** Searches cancelled while a server was still answering: its hits are dropped. */
const cancelledSearches = new Set<string>()
/** The searches running now: only one of them can be cancelled, so a cancel
 *  that arrives after its search ended is not kept. */
const inflightSearches = new Set<string>()

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
  // This Mac's transcripts stream as they are read; each server that holds
  // one of the asked conversations searches its own disk at the same time
  // (PRDCT-4321), its hits sent the same way. A conversation the last list
  // routed to a server is searched there only: a disk the Mac shares with
  // its server would otherwise show each of its hits twice.
  ipcMain.handle('history:search', async (event, request: unknown) => {
    const send = (progress: unknown): void => {
      if (!event.sender.isDestroyed()) event.sender.send('history:search-hits', progress)
    }
    const r = request as {
      requestId?: unknown
      query?: unknown
      scopes?: unknown
      claudeSessionIds?: unknown
    } | null
    const requestId = typeof r?.requestId === 'string' ? r.requestId : ''
    cancelledSearches.delete(requestId)
    if (requestId) inflightSearches.add(requestId)
    const scopes = Array.isArray(r?.scopes)
      ? r.scopes.filter((s): s is HistorySearchScope => SERVER_SCOPES.has(s as string))
      : []
    const ids = Array.isArray(r?.claudeSessionIds)
      ? r.claudeSessionIds.filter((id): id is string => typeof id === 'string')
      : []
    const { local: localIds, byServer } = splitSearchIds(ids, serverOwnerOf)
    const serverIds = [...byServer.values()].flat()
    try {
      const [local, servers] = await Promise.all([
        searchHistory({ ...(r ?? {}), claudeSessionIds: localIds }, send),
        requestId
          ? searchServers(
              { query: typeof r?.query === 'string' ? r.query : '', scopes, ids: serverIds },
              (hits) => send({ requestId, hits }),
              () => cancelledSearches.has(requestId)
            )
          : Promise.resolve({ filesSearched: 0, truncated: false })
      ])
      return {
        ...local,
        filesSearched: local.filesSearched + servers.filesSearched,
        truncated: local.truncated || servers.truncated
      }
    } finally {
      inflightSearches.delete(requestId)
      cancelledSearches.delete(requestId)
    }
  })
  ipcMain.on('history:search-cancel', (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') return
    if (inflightSearches.has(requestId)) cancelledSearches.add(requestId)
    cancelSearch(requestId)
  })
}
