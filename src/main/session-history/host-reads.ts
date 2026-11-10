/**
 * The History's reads of the session host (PRDCT-4236), shared by the IPC
 * handlers (the dialog, the ledger's stamps, the close's restamp) and the
 * agent tools (`clave_history`, `clave_open_session` with `resume`, the
 * close tool's restamp): the session's record for a ledger row, and the
 * History with the live launch of every held conversation laid over it.
 */
import type { Session, SessionRecord } from '@clave/contract/sessions'
import { listHistory, recordFor, restampLaunch, type StampRecordSource } from './service'
import { overlayLiveLaunch, recordsWithStopped } from './live-launch'
import { ptyManager } from '../pty-manager'
import { isServerExternal } from '../server/endpoint'
import { serverClient } from '../mcp/server-client'
import * as path from 'path'
import { app } from 'electron'
import type { HistorySearchScope } from '@clave/contract/history'
import type { ClaveApiClient } from '../../../packages/client/src/api'
import { serverConnectionRegistry } from '../ipc-handlers/server-handlers'
import {
  fileServerHistoryCache,
  mergeServerHistories,
  readServerHistories,
  type ServerHistoryCache,
  type ServerHistorySource
} from './fleet-history'

/** What these reads ask of the server's client. */
export interface HostSessionsApi {
  sessions: {
    listAdoptable(ids?: ReadonlyArray<string>): Promise<ReadonlyArray<SessionRecord>>
    list(): Promise<ReadonlyArray<Session>>
  }
}

/** The session's record for a ledger row's launch: main's own, else, when
 *  the sessions live on a server of their own, the server's. */
export const stampRecords: StampRecordSource = {
  local: (sessionId) => ptyManager.getSessionRecord(sessionId),
  remote: async (sessionId) => {
    if (!isServerExternal()) return null
    const records = await (await serverClient.api()).sessions.listAdoptable([sessionId])
    return records.find((r) => r.id === sessionId) ?? null
  }
}

/** The ledger told what a tab runs on before its record goes (round 6): main's
 *  record, else the server's. Never throws: a close must not wait on, or fail
 *  because of, the History. */
export async function restampSessionLaunch(sessionId: string): Promise<void> {
  try {
    const record = await recordFor(sessionId, stampRecords)
    if (record) await restampLaunch(sessionId, record)
  } catch (err) {
    console.error('[session-history] failed to restamp the launch', err)
  }
}

/** The records the holders are read from, over the server's client. */
export function hostRecords(api: HostSessionsApi): Promise<readonly SessionRecord[]> {
  return recordsWithStopped(
    (ids) => api.sessions.listAdoptable(ids),
    () => api.sessions.list()
  )
}

/** The History's memory with the live record of every held conversation laid
 *  over it (round 5 F1): what the tab's own Resume reads. A failed read of the
 *  records is the caller's to handle. */
export async function historyWithLiveLaunch(
  api: HostSessionsApi,
  records: () => Promise<readonly SessionRecord[]> = () => hostRecords(api)
): Promise<ReturnType<typeof listHistory>> {
  const listed = listHistory()
  return { ...listed, entries: overlayLiveLaunch(listed.entries, await records()) }
}

// ── PRDCT-4321: the History of every connected server ──

let serverCache: ServerHistoryCache | null = null
/** Each server's last answer, under this Mac's user data. */
function historyCache(): ServerHistoryCache {
  return (serverCache ??= fileServerHistoryCache(
    path.join(app.getPath('userData'), 'session-history', 'servers')
  ))
}

/** The connected servers, each read over a client of its own, disposed by
 *  `release` once the read is done. */
export function connectedServers(): ServerHistorySource & { release: () => Promise<void> } {
  const registry = serverConnectionRegistry()
  const clients = new Map<string, Promise<ClaveApiClient>>()
  const client = (serverId: string): Promise<ClaveApiClient> => {
    let made = clients.get(serverId)
    if (!made) {
      made = (async () => {
        const { createApiClient } = await import('../../../packages/client/src/api')
        return createApiClient(await registry.endpoint(serverId))
      })()
      clients.set(serverId, made)
    }
    return made
  }
  return {
    servers: () =>
      registry
        .list()
        .filter((c) => c.enabled)
        .map((c) => ({ id: c.id, name: c.name })),
    list: async (serverId) => (await (await client(serverId)).history.list()).conversations,
    search: async (serverId, request) => (await client(serverId)).history.search(request),
    release: async () => {
      await Promise.all(
        [...clients.values()].map((made) => made.then((c) => c.dispose()).catch(() => undefined))
      )
    }
  }
}

/** Which server answered for which conversation at the last list: what a
 *  search of the History asks of each server. */
const serverOfConversation = new Map<string, string>()

/** The History of this Mac with every connected server's laid in: the
 *  dialog's and the agents' read. A server that does not answer keeps its
 *  last answer's rows, offline. */
export async function historyWithServers(
  api: HostSessionsApi | null,
  source: ServerHistorySource & { release?: () => Promise<void> } = connectedServers()
): Promise<ReturnType<typeof listHistory>> {
  let local: ReturnType<typeof listHistory>
  try {
    local = api ? await historyWithLiveLaunch(api) : listHistory()
  } catch {
    local = listHistory()
  }
  try {
    const answers = await readServerHistories(source, historyCache())
    const entries = mergeServerHistories(local.entries, answers)
    serverOfConversation.clear()
    for (const e of entries)
      if (e.server?.online) serverOfConversation.set(e.claudeSessionId, e.server.id)
    return { ...local, entries }
  } finally {
    await source.release?.()
  }
}

/** The servers' half of a History search: each online server that answered
 *  for one of the asked conversations searches its own disk; its hits on
 *  those conversations are handed to `onHits`. Never throws. */
export async function searchServers(
  request: { query: string; scopes: HistorySearchScope[]; ids: readonly string[] },
  onHits: (
    hits: Array<{
      claudeSessionId: string
      ts: string | null
      scope: HistorySearchScope
      excerpt: string
    }>
  ) => void,
  cancelled: () => boolean,
  source: ServerHistorySource & { release?: () => Promise<void> } = connectedServers()
): Promise<{ filesSearched: number; truncated: boolean }> {
  const wanted = new Map<string, Set<string>>()
  for (const id of request.ids) {
    const serverId = serverOfConversation.get(id)
    if (!serverId) continue
    const set = wanted.get(serverId) ?? new Set<string>()
    set.add(id)
    wanted.set(serverId, set)
  }
  if (wanted.size === 0 || !request.query.trim() || request.scopes.length === 0)
    return { filesSearched: 0, truncated: false }
  try {
    const results = await Promise.all(
      [...wanted].map(async ([serverId, ids]) => {
        try {
          const result = await source.search(serverId, {
            query: request.query,
            scopes: request.scopes
          })
          const hits = result.hits
            .filter((h) => ids.has(h.conversationId))
            .map((h) => ({
              claudeSessionId: h.conversationId,
              ts: h.ts,
              scope: h.scope,
              excerpt: h.excerpt
            }))
          if (hits.length > 0 && !cancelled()) onHits(hits)
          return { filesSearched: result.filesSearched, truncated: result.truncated }
        } catch {
          return { filesSearched: 0, truncated: true }
        }
      })
    )
    return {
      filesSearched: results.reduce((n, r) => n + r.filesSearched, 0),
      truncated: results.some((r) => r.truncated)
    }
  } finally {
    await source.release?.()
  }
}
