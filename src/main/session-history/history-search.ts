/**
 * The History's search across this Mac and its servers (PRDCT-4321), the body
 * of the `history:search` handler kept free of Electron so it is tested as it
 * runs. This Mac's transcripts stream as they are read; each server that
 * holds one of the asked conversations searches its own disk at the same
 * time, its hits sent the same way. A conversation the last list routed to a
 * server is searched there only: a disk the Mac shares with its server would
 * otherwise show each of its hits twice.
 */
import type { HistorySearchScope } from '@clave/contract/history'
import type { SearchDone, SearchProgress } from './service'
import { splitSearchIds } from './fleet-history'

const SERVER_SCOPES: ReadonlySet<string> = new Set(['human', 'agent', 'tools'])

/** The searches running now and those of them cancelled while a server was
 *  still answering (its hits are then dropped). Only a search in flight can
 *  be cancelled: a cancel that arrives after its search ended is not kept,
 *  and the end of a search forgets it either way. */
export class SearchCancels {
  private readonly inflight = new Set<string>()
  private readonly cancelled = new Set<string>()

  begin(id: string): void {
    this.cancelled.delete(id)
    if (id) this.inflight.add(id)
  }

  cancel(id: string): void {
    if (this.inflight.has(id)) this.cancelled.add(id)
  }

  isCancelled(id: string): boolean {
    return this.cancelled.has(id)
  }

  end(id: string): void {
    this.inflight.delete(id)
    this.cancelled.delete(id)
  }
}

export interface HistorySearchDeps {
  /** This Mac's own search (`searchHistory`), over the ids no server holds. */
  searchLocal: (request: unknown, send: (progress: SearchProgress) => void) => Promise<SearchDone>
  /** The servers' search (`searchServers`), over the ids routed to them. */
  searchServers: (
    request: { query: string; scopes: HistorySearchScope[]; ids: readonly string[] },
    onHits: (hits: SearchProgress['hits']) => void,
    cancelled: () => boolean
  ) => Promise<{ filesSearched: number; truncated: boolean }>
  /** The server the last list routed a conversation to, if any. */
  serverOwnerOf: (id: string) => string | undefined
  /** Hits to the asking window. */
  send: (progress: SearchProgress) => void
  cancels: SearchCancels
}

/** Run one search over this Mac and its servers; resolves with the totals of
 *  both halves once both ended. */
export async function runHistorySearch(
  request: unknown,
  deps: HistorySearchDeps
): Promise<SearchDone> {
  const r = request as {
    requestId?: unknown
    query?: unknown
    scopes?: unknown
    claudeSessionIds?: unknown
  } | null
  const requestId = typeof r?.requestId === 'string' ? r.requestId : ''
  deps.cancels.begin(requestId)
  const scopes = Array.isArray(r?.scopes)
    ? r.scopes.filter((s): s is HistorySearchScope => SERVER_SCOPES.has(s as string))
    : []
  const ids = Array.isArray(r?.claudeSessionIds)
    ? r.claudeSessionIds.filter((id): id is string => typeof id === 'string')
    : []
  const { local: localIds, byServer } = splitSearchIds(ids, deps.serverOwnerOf)
  const serverIds = [...byServer.values()].flat()
  try {
    const [local, servers] = await Promise.all([
      deps.searchLocal({ ...(r ?? {}), claudeSessionIds: localIds }, deps.send),
      requestId
        ? deps.searchServers(
            { query: typeof r?.query === 'string' ? r.query : '', scopes, ids: serverIds },
            (hits) => deps.send({ requestId, hits }),
            () => deps.cancels.isCancelled(requestId)
          )
        : Promise.resolve({ filesSearched: 0, truncated: false })
    ])
    return {
      ...local,
      filesSearched: local.filesSearched + servers.filesSearched,
      truncated: local.truncated || servers.truncated
    }
  } finally {
    deps.cancels.end(requestId)
  }
}
