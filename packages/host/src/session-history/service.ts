import * as path from 'path'
import { homedir } from 'os'
import { app } from 'electron'
import { CaptureStore } from '../exchange-capture/store'
import { SessionLedger, normalizeLedgerRow } from './ledger'
import {
  captureEventsToRows,
  foldHistory,
  isTitleHelperConversation,
  unknownStems,
  type HistoryEntry
} from './index'
import {
  indexTranscripts,
  locateTranscript,
  PeekCache,
  type TranscriptPeek
} from './transcript-peek'
import { CodexCache, codexRoot, listCodexSessions } from './codex'
import { PiCache, listPiSessions, piRoot } from './pi'
import { searchTranscripts, type SearchHit, type SearchScope } from './search'
import { ConversationCache, type ConversationTurn } from './conversation'

/**
 * Session-history service: the main-process owner of the ledger and the one
 * reader of the history (PRDCT-1738).
 *
 * `stamp` is fire-and-forget from the renderer's store diff — a ledger
 * failure is logged, never thrown back into a store update. `list` folds the
 * ledger (plus the exchange-capture stream as the pre-ledger seed) into one
 * entry per Claude session and decorates each with a peek at its
 * transcript's tail: title, last prompt, last human timestamp, and whether
 * the file is still on disk (Claude Code cleans transcripts after
 * `cleanupPeriodDays`, 30 by default; a cleaned session stays listed, greyed).
 *
 * The list's universe is the WHOLE transcript store (PRDCT-1766), not only
 * what the ledger knows: every unclaimed stem under the claude store is
 * synthesized into an entry, and the codex store's rollout files join with
 * `provider: 'codex'` — listed, counted and searchable, resumable only where
 * a resume exists (claude today). The ledger's contribution is the group
 * placements the chips filter by.
 *
 * The transcripts root is `~/.claude/projects` unless `CLAVE_TRANSCRIPTS_ROOT`
 * names another directory — the E2E harness's way of seeding transcripts
 * without touching the real store. Peeks are cached per (path, size, mtime)
 * (`PeekCache`: a stat per file, a read only when it moved), and the root's
 * transcripts are indexed once per list rather than probed once per miss.
 */

export interface HistoryListEntry extends HistoryEntry {
  /** Where the entry comes from: the ledger (a conversation Clave ran), or
   *  a transcript a store holds that Clave never saw. */
  source: 'ledger' | 'transcript'
  /** Which CLI's conversation this is — the counts line's word. Resume
   *  exists for claude only today; the others are listed and searchable. */
  provider: 'claude' | 'codex' | 'pi' | 'antigravity'
  agentProvider?: string | null
  thinking?: string | null
  /** The store dir a synthesized entry was found under — the workspace
   *  fallback when its transcript carries no cwd at all. */
  projectDir?: string
  transcript: TranscriptPeek
  /** The row's title: Claude Code's own title when the tail carries one, else
   *  the tab's name as the ledger last saw it. */
  title: string
  /** Best "last human message" time: the transcript's, else the ledger's
   *  last sighting, else the file's mtime. Always set, so the sort is total. */
  lastHumanAt: string
}

let ledger: SessionLedger | null = null
let capture: CaptureStore | null = null
const peekCache = new PeekCache()
const codexCache = new CodexCache()
const piCache = new PiCache()
const conversations = new ConversationCache()
/** Transcript path per session as of the last list — what a search reads. */
const pathById = new Map<string, string | null>()
const searches = new Map<string, AbortController>()

function getLedger(): SessionLedger {
  if (!ledger) ledger = new SessionLedger(path.join(app.getPath('userData'), 'session-history'))
  return ledger
}

function getCapture(): CaptureStore {
  if (!capture) capture = new CaptureStore(path.join(app.getPath('userData'), 'exchange-capture'))
  return capture
}

export function transcriptsRoot(): string {
  return process.env.CLAVE_TRANSCRIPTS_ROOT || path.join(homedir(), '.claude', 'projects')
}

/** Validate, then append. The one place a row enters the ledger. */
export function stampHistory(input: unknown): void {
  const row = normalizeLedgerRow(input)
  if (!row) {
    console.error('[session-history] refusing to write a malformed ledger row')
    return
  }
  try {
    getLedger().append(row)
  } catch (err) {
    console.error('[session-history] failed to append to the ledger', err)
  }
}

export function listHistory(): {
  entries: HistoryListEntry[]
  skippedLines: number
} {
  const { rows, skippedLines } = getLedger().readAll()
  const seed = captureEventsToRows(getCapture().readAll().events as never[])
  const root = transcriptsRoot()
  const index = indexTranscripts(root)
  const entries = foldHistory([...seed, ...rows])
    // Nothing to resume without a Claude transcript: `claude agents` tabs
    // and the other CLIs never make a ledger row.
    .filter((e) => e.mode === 'claude')
    .map((e): HistoryListEntry => {
      const file = locateTranscript(root, e.cwd, e.claudeSessionId, index)
      pathById.set(e.claudeSessionId, file)
      const transcript = peekCache.get(file)
      return {
        ...e,
        source: 'ledger' as const,
        provider: 'claude' as const,
        transcript,
        title: transcript.title ?? e.name,
        lastHumanAt:
          transcript.lastHumanAt ?? e.lastSeenAt ?? transcript.modifiedAt ?? e.firstSeenAt
      }
    })
  const known = new Set(entries.map((e) => e.claudeSessionId))
  // One stem can live under TWO project dirs (`claude --resume` run from a
  // subdirectory writes a stub beside the real transcript): same
  // conversation, one row — the larger file wins, and it is also the one
  // the search reads.
  const synthAt = new Map<string, number>()
  for (const { dir, stem } of unknownStems(index, known)) {
    const file = path.join(root, dir, `${stem}.jsonl`)
    const transcript = peekCache.get(file)
    if (!transcript.exists) continue
    // The app's own tab-title helper calls (`claude -p`) leave transcripts
    // too; its own plumbing is never a conversation.
    if (isTitleHelperConversation(transcript.lastPrompt)) continue
    const existingAt = synthAt.get(stem)
    if (existingAt !== undefined) {
      if (entries[existingAt].transcript.sizeBytes >= transcript.sizeBytes) continue
      entries.splice(existingAt, 1)
      synthAt.delete(stem)
      for (const [k, v] of synthAt) if (v > existingAt) synthAt.set(k, v - 1)
    }
    pathById.set(stem, file)
    const firstSeenAt = transcript.firstAt ?? transcript.modifiedAt ?? ''
    const lastHumanAt = transcript.lastHumanAt ?? transcript.modifiedAt ?? firstSeenAt
    synthAt.set(stem, entries.length)
    entries.push({
      projectDir: dir,
      claudeSessionId: stem,
      sessionId: '',
      name: '',
      cwd: transcript.cwd ?? '',
      mode: 'claude',
      model: null,
      workspaceId: null,
      groups: [],
      firstSeenAt,
      lastSeenAt: lastHumanAt,
      closedAt: null,
      source: 'transcript',
      provider: 'claude',
      transcript,
      title: transcript.title ?? `Conversation ${stem.slice(0, 8)}`,
      lastHumanAt
    })
  }
  // The codex store: one row per user thread (subagent threads folded away
  // by the scanner), titled by the first human message, inert to resume.
  for (const c of listCodexSessions(codexRoot(), codexCache)) {
    if (known.has(c.id)) continue
    known.add(c.id)
    // A thread whose meta carries no absolute cwd cannot be scoped to any
    // workspace (codex has no per-project store dir to fall back on, the
    // way a claude transcript does): unlisted, never shown in every one.
    if (!c.cwd) continue
    pathById.set(c.id, c.path)
    const firstSeenAt = c.firstAt ?? c.modifiedAt ?? ''
    const lastAt = c.modifiedAt ?? firstSeenAt
    entries.push({
      claudeSessionId: c.id,
      sessionId: '',
      name: '',
      cwd: c.cwd ?? '',
      mode: 'codex',
      model: null,
      workspaceId: null,
      groups: [],
      firstSeenAt,
      lastSeenAt: lastAt,
      closedAt: null,
      source: 'transcript',
      provider: 'codex',
      transcript: {
        exists: true,
        path: c.path,
        cwd: c.cwd,
        firstAt: c.firstAt,
        title: null,
        lastPrompt: null,
        lastHumanAt: null,
        modifiedAt: c.modifiedAt,
        sizeBytes: c.sizeBytes
      },
      title: firstLine(c.firstUserText) ?? `Codex conversation ${c.id.slice(0, 8)}`,
      lastHumanAt: lastAt
    })
  }
  for (const p of listPiSessions(piRoot(), piCache)) {
    if (known.has(p.id) || !p.cwd) continue
    known.add(p.id)
    pathById.set(p.id, p.path)
    const firstSeenAt = p.firstAt ?? p.modifiedAt ?? ''
    const lastAt = p.modifiedAt ?? firstSeenAt
    entries.push({
      claudeSessionId: p.id,
      sessionId: '',
      name: '',
      cwd: p.cwd,
      mode: 'pi',
      model: p.model,
      workspaceId: null,
      groups: [],
      firstSeenAt,
      lastSeenAt: lastAt,
      closedAt: null,
      source: 'transcript',
      provider: 'pi',
      agentProvider: p.provider,
      thinking: p.thinking,
      transcript: {
        exists: true,
        path: p.path,
        cwd: p.cwd,
        firstAt: p.firstAt,
        title: null,
        lastPrompt: p.lastUserText,
        lastHumanAt: null,
        modifiedAt: p.modifiedAt,
        sizeBytes: p.sizeBytes
      },
      title: firstLine(p.firstUserText) ?? `Pi conversation ${p.id.slice(0, 8)}`,
      lastHumanAt: lastAt
    })
  }
  return { entries, skippedLines }
}

/** The first line of a codex opening message, cut to a title's length. */
function firstLine(text: string | null): string | null {
  if (!text) return null
  const one = text.split('\n')[0].replace(/\s+/g, ' ').trim()
  if (!one) return null
  return one.length > 80 ? `${one.slice(0, 79)}…` : one
}

/** The message trail's read (one live tab's conversation): locate the
 *  transcript, fold what was appended since the last call. `locateTranscript`
 *  validates the id alphabet, so a traversal string resolves to nothing. */
export function getConversation(input: unknown): { exists: boolean; turns: ConversationTurn[] } {
  const r = input as { cwd?: unknown; claudeSessionId?: unknown; provider?: unknown } | null
  const cwd = typeof r?.cwd === 'string' ? r.cwd : null
  const claudeSessionId = typeof r?.claudeSessionId === 'string' ? r.claudeSessionId : null
  if (!cwd || !claudeSessionId) return { exists: false, turns: [] }
  let file: string | null
  if (r?.provider === 'pi') {
    file = pathById.get(claudeSessionId) ?? null
    if (!file) {
      const session = listPiSessions(piRoot(), piCache).find(
        (candidate) => candidate.id === claudeSessionId && candidate.cwd === cwd
      )
      file = session?.path ?? null
      if (file) pathById.set(claudeSessionId, file)
    }
  } else {
    file = locateTranscript(transcriptsRoot(), cwd, claudeSessionId)
  }
  return conversations.read(file)
}

export interface SearchRequest {
  requestId: string
  query: string
  /** The toggled scopes, any subset; an empty set searches nothing. */
  scopes: SearchScope[]
  /** The sessions in the dialog's current scope; unknown ids and sessions
   *  whose transcript is gone are skipped. */
  claudeSessionIds: string[]
}

export interface SearchProgress {
  requestId: string
  hits: SearchHit[]
}

export interface SearchDone {
  requestId: string
  filesSearched: number
  truncated: boolean
}

const SCOPES: ReadonlySet<string> = new Set<SearchScope>(['human', 'agent', 'tools'])

/** Run one scoped search over the named sessions' transcripts, streaming
 *  hits through `onHits`. A second request with the same id cancels the
 *  first. Resolves when the search ends, cancelled or not. */
export async function searchHistory(
  input: unknown,
  onHits: (progress: SearchProgress) => void
): Promise<SearchDone> {
  const r = input as Partial<SearchRequest> | null
  const requestId = typeof r?.requestId === 'string' ? r.requestId : ''
  const query = typeof r?.query === 'string' ? r.query : ''
  const scopes = Array.isArray(r?.scopes)
    ? (r.scopes.filter((s): s is SearchScope => typeof s === 'string' && SCOPES.has(s)) ?? [])
    : []
  const ids = Array.isArray(r?.claudeSessionIds)
    ? r.claudeSessionIds.filter((id): id is string => typeof id === 'string')
    : []
  if (!requestId || scopes.length === 0) return { requestId, filesSearched: 0, truncated: false }
  cancelSearch(requestId)
  const ac = new AbortController()
  searches.set(requestId, ac)
  try {
    const files = ids
      .map((id) => ({ claudeSessionId: id, path: pathById.get(id) ?? null }))
      .filter((f): f is { claudeSessionId: string; path: string } => f.path !== null)
    const result = await searchTranscripts(files, {
      query,
      scopes,
      signal: ac.signal,
      onHits: (hits) => {
        if (!ac.signal.aborted) onHits({ requestId, hits })
      }
    })
    return { requestId, filesSearched: result.filesSearched, truncated: result.truncated }
  } finally {
    if (searches.get(requestId) === ac) searches.delete(requestId)
  }
}

export function cancelSearch(requestId: string): void {
  const running = searches.get(requestId)
  if (!running) return
  running.abort()
  searches.delete(requestId)
}
