import type { LedgerRow } from './ledger'

/**
 * The fold: ledger rows (and, as a one-time seed, the exchange-capture
 * events written before the ledger existed) → one entry per Claude Code
 * session, the unit the history dialog lists and resumes.
 *
 * Keyed by `claudeSessionId`, not by Clave's tab id: a tab that ran `/clear`
 * rotated to a new transcript and is two resumable conversations; a
 * transcript resumed into a new tab is still one conversation. Rows without a
 * transcript id (terminals, other CLIs) are folded but never listed — there
 * is nothing to resume.
 *
 * Pure over parsed rows: no fs, no Electron, so the unit tests pin it.
 */

export interface HistoryGroupRef {
  id: string
  /** The group's name as of the LAST row that placed the session in it. */
  name: string
  /** When the session was first seen in this group. */
  firstAt: string
}

export interface HistoryEntry {
  claudeSessionId: string
  /** Clave's tab id as of the last row. */
  sessionId: string
  name: string
  cwd: string
  mode: LedgerRow['mode']
  model: string | null
  workspaceId: string | null
  /** Every group the session lived in, first seen first. A session dragged
   *  from A to B is in both: it OCCURRED in A. */
  groups: HistoryGroupRef[]
  firstSeenAt: string
  lastSeenAt: string
  /** The last `closed` row's timestamp, or null while never closed (or
   *  re-placed after a close — a resumed tab). */
  closedAt: string | null
}

/** A capture-stream line reduced to what the fold needs. Built by
 *  `captureEventsToRows` from the exchange-capture store; the fold itself
 *  only ever sees ledger rows. */
export interface CaptureIdentityEvent {
  kind: string
  ts: string
  session?: {
    sessionId?: unknown
    name?: unknown
    mode?: unknown
    cwd?: unknown
    claudeSessionId?: unknown
    groupId?: unknown
    groupName?: unknown
    model?: unknown
  }
}

const MODES: ReadonlySet<string> = new Set([
  'claude',
  'antigravity',
  'codex',
  'pi',
  'claude-agents',
  'terminal'
])

/**
 * The seed: exchange-capture `session_state`, `tab_closed` and `tab_spawn`
 * events carry the session's identity as of the event — including its group
 * — so the days before the ledger existed still produce entries. Workspace is
 * unknown to the stream (null), which the reader treats as "visible
 * everywhere". Events whose identity is malformed are skipped.
 */
export function captureEventsToRows(events: CaptureIdentityEvent[]): LedgerRow[] {
  const rows: LedgerRow[] = []
  for (const e of events) {
    if (e.kind !== 'session_state' && e.kind !== 'tab_closed' && e.kind !== 'tab_spawn') continue
    const s = e.session
    if (!s || typeof e.ts !== 'string') continue
    const sessionId = typeof s.sessionId === 'string' ? s.sessionId : null
    const name = typeof s.name === 'string' ? s.name : null
    const cwd = typeof s.cwd === 'string' ? s.cwd : null
    const mode =
      typeof s.mode === 'string' && MODES.has(s.mode) ? (s.mode as LedgerRow['mode']) : null
    if (!sessionId || name === null || !cwd || !mode) continue
    rows.push({
      v: 1,
      kind: e.kind === 'tab_closed' ? 'closed' : 'placed',
      ts: e.ts,
      sessionId,
      claudeSessionId: typeof s.claudeSessionId === 'string' ? s.claudeSessionId : null,
      name,
      cwd,
      mode,
      model: typeof s.model === 'string' ? s.model : null,
      workspaceId: null,
      groupId: typeof s.groupId === 'string' ? s.groupId : null,
      groupName: typeof s.groupName === 'string' ? s.groupName : null
    })
  }
  return rows
}

/** Fold rows into entries. Rows are sorted by timestamp first so the seed
 *  (older) and the ledger (newer) interleave correctly whatever order the
 *  caller concatenated them in; the LAST row wins every scalar. */
export function foldHistory(rows: LedgerRow[]): HistoryEntry[] {
  const sorted = [...rows].sort((a, b) => a.ts.localeCompare(b.ts))
  const byId = new Map<string, HistoryEntry>()
  for (const row of sorted) {
    if (!row.claudeSessionId) continue
    let entry = byId.get(row.claudeSessionId)
    if (!entry) {
      entry = {
        claudeSessionId: row.claudeSessionId,
        sessionId: row.sessionId,
        name: row.name,
        cwd: row.cwd,
        mode: row.mode,
        model: row.model,
        workspaceId: row.workspaceId,
        groups: [],
        firstSeenAt: row.ts,
        lastSeenAt: row.ts,
        closedAt: null
      }
      byId.set(row.claudeSessionId, entry)
    }
    entry.sessionId = row.sessionId
    entry.name = row.name
    entry.cwd = row.cwd
    entry.mode = row.mode
    entry.model = row.model ?? entry.model
    // The seed knows no workspace: a null must never erase a stamped one.
    entry.workspaceId = row.workspaceId ?? entry.workspaceId
    entry.lastSeenAt = row.ts
    if (row.groupId) {
      const existing = entry.groups.find((g) => g.id === row.groupId)
      if (existing) existing.name = row.groupName ?? existing.name
      else entry.groups.push({ id: row.groupId, name: row.groupName ?? '', firstAt: row.ts })
    }
    entry.closedAt = row.kind === 'closed' ? row.ts : null
  }
  return [...byId.values()]
}

/** The opening line of Clave's OWN tab-title helper prompt — the
 *  title-generator builds its prompt from this constant, so the two can
 *  never drift. Those `claude -p` one-shots land in the transcript store
 *  like any conversation, and the history must never list the app's own
 *  plumbing as one. */
export const TITLE_HELPER_MARKER =
  'Generate a short 2-4 word title for this Claude Code terminal session'

/** Is a store-only transcript one of Clave's own title-helper calls? Judged
 *  by the prompt the helper itself sent, read back off the tail. */
export function isTitleHelperConversation(lastPrompt: string | null): boolean {
  return lastPrompt !== null && lastPrompt.trimStart().startsWith(TITLE_HELPER_MARKER)
}

/** The transcripts the ledger does not know: every stem in the store's index
 *  that no folded entry claims — the whole-store universe's material. The `-`
 *  project dir is Claude Code's own one-shot helpers, never a conversation. */
export function unknownStems(
  index: ReadonlyMap<string, ReadonlySet<string>>,
  known: ReadonlySet<string>
): { dir: string; stem: string }[] {
  const out: { dir: string; stem: string }[] = []
  for (const [dir, stems] of index) {
    if (dir === '-') continue
    for (const stem of stems) {
      if (!known.has(stem)) out.push({ dir, stem })
    }
  }
  return out
}
