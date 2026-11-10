import * as fs from 'fs'
import * as path from 'path'
import { LOCAL_SERVER_ID, parseSessionKey, resourceKey, sessionKey } from '@clave/contract/fleet'
import type {
  HistoryConversation,
  HistorySearchHit,
  HistorySearchScope
} from '@clave/contract/history'
import type { HistoryListEntry, HistoryServerRef } from './service'

/**
 * The servers' Histories in this Mac's (PRDCT-4321).
 *
 * Each connected server answers the conversations its own tabs ran
 * (`server-conversations.ts`), read on its own disk. They are listed beside
 * this Mac's own, one row per conversation, each tagged with its server and
 * keyed so a Resume routes to that server (`sessionId` is the server tab's
 * owner key). A server that does not answer keeps the rows of its last
 * answer, kept on this Mac's disk, marked offline: still listed, never
 * resumed until it is back.
 *
 * One row per conversation: a server's row replaces this Mac's sight of the
 * same conversation when that sight is a bare transcript on a disk the two
 * share, or this Mac's own record of the server's tab (a tab it saw close);
 * a conversation a tab of THIS Mac ran stays this Mac's unless the server
 * saw it later.
 */

export interface FleetServer {
  id: string
  name: string
}

export interface ServerHistorySource {
  /** The servers this Mac is connected to (enabled connections). */
  servers: () => FleetServer[]
  list: (serverId: string) => Promise<readonly HistoryConversation[]>
  search: (
    serverId: string,
    request: { query: string; scopes: HistorySearchScope[]; maxHits?: number }
  ) => Promise<{ hits: readonly HistorySearchHit[]; filesSearched: number; truncated: boolean }>
}

export interface ServerHistoryCache {
  read: (serverId: string) => readonly HistoryConversation[] | null
  write: (serverId: string, conversations: readonly HistoryConversation[]) => void
}

export interface ServerAnswer {
  server: FleetServer
  online: boolean
  conversations: readonly HistoryConversation[]
}

/** How long the list waits for one server before taking its last answer. */
export const SERVER_HISTORY_TIMEOUT_MS = 3_000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The server did not answer in time.')), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/** Every connected server's History, at once: its answer (kept for when it
 *  is offline), else its last answer marked offline. Never throws. */
export async function readServerHistories(
  source: ServerHistorySource,
  cache: ServerHistoryCache,
  timeoutMs = SERVER_HISTORY_TIMEOUT_MS
): Promise<ServerAnswer[]> {
  let servers: FleetServer[]
  try {
    servers = source.servers().filter((s) => s.id !== LOCAL_SERVER_ID)
  } catch {
    return []
  }
  return Promise.all(
    servers.map(async (server): Promise<ServerAnswer> => {
      try {
        const conversations = await withTimeout(source.list(server.id), timeoutMs)
        try {
          cache.write(server.id, conversations)
        } catch {
          // A cache that cannot be written costs the offline view, never the list.
        }
        return { server, online: true, conversations }
      } catch {
        let kept: readonly HistoryConversation[] = []
        try {
          kept = cache.read(server.id) ?? []
        } catch {
          kept = []
        }
        return { server, online: false, conversations: kept }
      }
    })
  )
}

/** A server's conversation as a History row. */
export function serverEntry(
  server: FleetServer,
  online: boolean,
  c: HistoryConversation
): HistoryListEntry {
  const ref: HistoryServerRef = { id: server.id, name: server.name, online, held: c.held }
  return {
    source: 'server',
    server: ref,
    provider: 'claude',
    claudeSessionId: c.conversationId,
    sessionId: sessionKey({ serverId: server.id, sessionId: c.sessionId }),
    name: c.name,
    cwd: c.cwd,
    mode: 'claude',
    model: c.model,
    workspaceId: c.workspaceId ? resourceKey('workspace', server.id, c.workspaceId) : null,
    groups: c.groupId
      ? [
          {
            id: resourceKey('group', server.id, c.groupId),
            name: c.groupName ?? '',
            firstAt: c.firstSeenAt
          }
        ]
      : [],
    firstSeenAt: c.firstSeenAt,
    lastSeenAt: c.lastHumanAt,
    closedAt: c.held === 'closed' ? c.lastHumanAt : null,
    ...(c.launch ? { launch: c.launch } : {}),
    transcript: {
      exists: c.transcript === 'present',
      path: '',
      cwd: c.cwd,
      firstAt: c.firstSeenAt,
      title: c.title,
      lastPrompt: c.lastPrompt,
      lastHumanAt: c.lastHumanAt,
      modifiedAt: null,
      sizeBytes: 0
    },
    title: c.title ?? c.name,
    lastHumanAt: c.lastHumanAt
  }
}

/** The server a row's tab key names, or null for this Mac's own. */
function ownerOfKey(sessionId: string): string | null {
  if (!sessionId) return null
  try {
    const owner = parseSessionKey(sessionId).serverId
    return owner === LOCAL_SERVER_ID ? null : owner
  } catch {
    return null
  }
}

/** This Mac's History with every server's laid in: one row per conversation. */
export function mergeServerHistories(
  local: readonly HistoryListEntry[],
  answers: readonly ServerAnswer[]
): HistoryListEntry[] {
  const known = new Map(answers.map((a) => [a.server.id, a]))
  const remote = new Map<string, HistoryListEntry>()
  for (const answer of answers) {
    for (const c of answer.conversations) {
      // One malformed conversation (an older server, a damaged cache) is
      // skipped alone; it never costs the other rows.
      let entry: HistoryListEntry
      try {
        entry = serverEntry(answer.server, answer.online, c)
      } catch {
        continue
      }
      const before = remote.get(entry.claudeSessionId)
      // Two servers naming one conversation (a disk they share): the later wins.
      if (!before || before.lastHumanAt < entry.lastHumanAt)
        remote.set(entry.claudeSessionId, entry)
    }
  }
  const out: HistoryListEntry[] = []
  for (const entry of local) {
    const owner = ownerOfKey(entry.sessionId)
    const theirs = remote.get(entry.claudeSessionId)
    if (theirs) {
      // This Mac's own tab ran it, and saw it after the server did: its row.
      const ours =
        entry.source === 'ledger' && owner === null && entry.lastSeenAt > theirs.lastHumanAt
      if (ours) {
        remote.delete(entry.claudeSessionId)
        out.push(entry)
      }
      continue
    }
    if (owner !== null) {
      // This Mac's own record of a server's tab (it saw the tab open or
      // close) that the server's answer does not name: still that server's
      // conversation, never one of this Mac's, whatever this disk holds.
      const answer = known.get(owner)
      out.push({
        ...entry,
        server: {
          id: owner,
          name: answer?.server.name ?? 'Server',
          online: answer?.online ?? false,
          held: null
        }
      })
      continue
    }
    out.push(entry)
  }
  out.push(...remote.values())
  return out
}

/** The last answer of each server, one file per server under `dir`. */
export function fileServerHistoryCache(dir: string): ServerHistoryCache {
  const fileOf = (serverId: string): string =>
    path.join(dir, `${encodeURIComponent(serverId)}.json`)
  return {
    read(serverId) {
      try {
        const parsed = JSON.parse(fs.readFileSync(fileOf(serverId), 'utf-8')) as {
          conversations?: unknown
        }
        return Array.isArray(parsed.conversations)
          ? (parsed.conversations as HistoryConversation[])
          : null
      } catch {
        return null
      }
    },
    write(serverId, conversations) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = fileOf(serverId)
      const temp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ v: 1, conversations }), { mode: 0o600 })
      fs.renameSync(temp, file)
    }
  }
}
