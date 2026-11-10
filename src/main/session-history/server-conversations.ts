import * as fs from 'fs'
import * as path from 'path'
import type { SessionRecord } from '@clave/contract/sessions'
import type {
  HistoryConversation,
  HistorySearchResult,
  HistorySearchScope,
  ServerHistory
} from '@clave/contract/history'
import { SessionLedger, type LedgerRow } from './ledger'
import { foldHistory, isTitleHelperConversation, type HistoryEntry } from './index'
import { launchOfRecord } from './live-launch'
import {
  indexTranscripts,
  locateTranscript,
  PeekCache,
  transcriptPath,
  transcriptsRoot as sharedRoot,
  type TranscriptIndex
} from './transcript-peek'
import { searchTranscripts } from './search'

/**
 * A server's own History (PRDCT-4321): the conversations its tabs ran, kept
 * after a tab is closed or deleted, read on the server's own disk.
 *
 * The server keeps a ledger of its own, `<dataDir>/history/ledger.jsonl`, in
 * the desktop's ledger format (`ledger.ts`), one row each time a tab's
 * conversation, name, folder or group changes, and one when the tab goes. A
 * tab is observed when it starts, at each of its state changes (a new
 * conversation after `/clear` shows there), when it is renamed or resumed;
 * its record's last word is stamped before the record is discarded, which is
 * what keeps a deleted tab's conversation listed. A list first reconciles the
 * records the server holds, so a crash between two observations loses
 * nothing a record still says.
 *
 * Only Claude conversations are listed: they are what the History resumes.
 * Only what this server's tabs ran is listed, never every transcript of its
 * disk: a Mac whose own server shares its disk would otherwise list each of
 * its conversations twice.
 *
 * No Electron: the daemon runs this.
 */

export interface ServerConversationsOptions {
  /** The server's data directory; the ledger lives under `history/`. */
  dataDir: string
  /** Every record the server holds, running or stopped. */
  records: () => readonly SessionRecord[]
  /** Whether a tab of the server runs this session id now. */
  running: (sessionId: string) => boolean
  /** The server group a tab lives in, when the server keeps a sidebar. */
  groupOf?: (sessionId: string) => { id: string; name: string; workspaceId?: string } | null
  /** The shared transcripts root; `~/.claude/projects` by default. */
  transcriptsRoot?: () => string
  now?: () => Date
  /** Where a failed ledger write is told; `console.error` by default. */
  log?: (message: string, error: unknown) => void
}

export interface ServerConversations {
  /** Stamp the tab's conversation when what the History shows of it changed. */
  observe(sessionId: string): void
  /** Stamp the record's last word as the tab goes: before its discard. */
  closing(record: SessionRecord): void
  list(): ServerHistory
  search(request: {
    query: string
    scopes: HistorySearchScope[]
    maxHits?: number
    signal?: AbortSignal
  }): Promise<HistorySearchResult>
}

/** How long a search may read before it answers with what it found. */
export const SEARCH_BUDGET_MS = 20_000

function isClaudeConversation(record: SessionRecord): boolean {
  return (
    record.claudeMode &&
    // A routine's run or a group's terminal is no sidebar tab: the desktop's
    // History never lists them either.
    !record.link &&
    !record.claudeAgentsMode &&
    !record.codexMode &&
    !record.piMode &&
    !record.antigravityMode &&
    typeof record.claudeSessionId === 'string' &&
    record.claudeSessionId.length > 0
  )
}

/** What the History shows of a tab: a change of any of these is a row. */
function identityOf(row: LedgerRow): string {
  return JSON.stringify([
    row.claudeSessionId,
    row.name,
    row.cwd,
    row.model,
    row.workspaceId,
    row.groupId,
    row.groupName,
    row.configDir ?? null,
    row.dangerous ?? null,
    row.permissionMode ?? null,
    row.effort ?? null,
    row.accountId ?? null
  ])
}

export function serverConversations(options: ServerConversationsOptions): ServerConversations {
  const ledger = new SessionLedger(path.join(options.dataDir, 'history'))
  const root = options.transcriptsRoot ?? sharedRoot
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((message, error) => console.error(message, error))
  const peeks = new PeekCache()
  /** The identity last stamped per tab id, seeded from the ledger itself so
   *  a restart stamps nothing that did not change. */
  const stamped = new Map<string, string>()
  for (const row of ledger.readAll().rows) stamped.set(row.sessionId, identityOf(row))

  const rowOf = (record: SessionRecord, kind: LedgerRow['kind']): LedgerRow | null => {
    if (!isClaudeConversation(record)) return null
    const group = options.groupOf?.(record.id) ?? null
    const configDir =
      typeof record.configDir === 'string' && path.isAbsolute(record.configDir)
        ? record.configDir
        : undefined
    return {
      v: 1,
      kind,
      ts: now().toISOString(),
      sessionId: record.id,
      claudeSessionId: record.claudeSessionId!,
      name: record.displayName ?? record.folderName,
      cwd: record.cwd,
      mode: 'claude',
      model: record.model ?? null,
      workspaceId: record.workspaceId ?? group?.workspaceId ?? null,
      groupId: group?.id ?? null,
      groupName: group?.name ?? null,
      ...launchOfRecord(record),
      ...(configDir ? { configDir } : {})
    }
  }

  const append = (row: LedgerRow): void => {
    try {
      ledger.append(row)
      stamped.set(row.sessionId, identityOf(row))
    } catch (error) {
      log('[server-history] failed to append to the ledger', error)
    }
  }

  const stampIfChanged = (record: SessionRecord): void => {
    const row = rowOf(record, 'placed')
    if (!row) return
    if (stamped.get(record.id) === identityOf(row)) return
    append(row)
  }

  const reconcile = (): void => {
    for (const record of options.records()) stampIfChanged(record)
  }

  /** The transcript's file: under the tab's account directory when it ran
   *  with one, else the shared root (by its folder, then by the index). */
  const locate = (entry: HistoryEntry, index: TranscriptIndex, shared: string): string | null => {
    if (entry.configDir) {
      const own = transcriptPath(
        path.join(entry.configDir, 'projects'),
        entry.cwd,
        entry.claudeSessionId
      )
      if (fs.existsSync(own)) return own
    }
    return locateTranscript(shared, entry.cwd, entry.claudeSessionId, index)
  }

  const listed = (): Array<{ conversation: HistoryConversation; file: string | null }> => {
    reconcile()
    const { rows } = ledger.readAll()
    const holders = new Map<string, SessionRecord>()
    for (const record of options.records()) {
      if (isClaudeConversation(record)) holders.set(record.claudeSessionId!, record)
    }
    const shared = root()
    const index = indexTranscripts(shared)
    const out: Array<{ conversation: HistoryConversation; file: string | null }> = []
    for (const entry of foldHistory(rows)) {
      if (entry.mode !== 'claude') continue
      const file = locate(entry, index, shared)
      const peek = peeks.get(file)
      if (isTitleHelperConversation(peek.lastPrompt)) continue
      const holder = holders.get(entry.claudeSessionId)
      const held: HistoryConversation['held'] = holder
        ? options.running(holder.id)
          ? 'running'
          : 'stopped'
        : 'closed'
      const lastHumanAt =
        peek.lastHumanAt ?? entry.lastSeenAt ?? peek.modifiedAt ?? entry.firstSeenAt
      out.push({
        file: peek.exists ? peek.path : null,
        conversation: {
          conversationId: entry.claudeSessionId,
          sessionId: holder?.id ?? entry.sessionId,
          name: entry.name,
          title: peek.title,
          cwd: entry.cwd,
          model: entry.model,
          groupId: entry.groups.at(-1)?.id ?? null,
          groupName: entry.groups.at(-1)?.name || null,
          workspaceId: entry.workspaceId,
          firstSeenAt: entry.firstSeenAt,
          lastHumanAt,
          lastPrompt: peek.lastPrompt,
          transcript: peek.exists ? 'present' : 'gone',
          held,
          ...(entry.launch ? { launch: entry.launch } : {})
        }
      })
    }
    return out
  }

  return {
    observe(sessionId) {
      const record = options.records().find((r) => r.id === sessionId)
      if (record) stampIfChanged(record)
    },
    closing(record) {
      const row = rowOf(record, 'closed')
      if (row) append(row)
    },
    list() {
      return { conversations: listed().map((l) => l.conversation) }
    },
    async search(request) {
      const files = listed()
        .filter((l) => l.file !== null)
        .sort((a, b) => b.conversation.lastHumanAt.localeCompare(a.conversation.lastHumanAt))
        .map((l) => ({ claudeSessionId: l.conversation.conversationId, path: l.file! }))
      const budget = new AbortController()
      const timer = setTimeout(() => budget.abort(), SEARCH_BUDGET_MS)
      const abort = (): void => budget.abort()
      request.signal?.addEventListener('abort', abort)
      try {
        const result = await searchTranscripts(files, {
          query: request.query,
          scopes: request.scopes,
          maxHits: request.maxHits,
          signal: budget.signal
        })
        return {
          hits: result.hits.map((h) => ({
            conversationId: h.claudeSessionId,
            ts: h.ts,
            scope: h.scope,
            excerpt: h.excerpt
          })),
          filesSearched: result.filesSearched,
          truncated: result.truncated
        }
      } finally {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
      }
    }
  }
}
