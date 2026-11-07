import * as fs from 'fs'
import * as path from 'path'

/**
 * The session ledger: Clave's own record of WHERE a session lived (PRDCT-1738).
 *
 * A closed tab leaves nothing behind that says which group it sat in — the
 * session record is deleted on kill and the sidebar layout drops the id the
 * moment the tab goes — while the conversation itself survives on disk in
 * Claude Code's transcript and `claude --resume` reopens it. This file is the
 * missing link: one append-only JSON Lines ledger for the whole install,
 * `<userData>/session-history/ledger.jsonl`, one row per CHANGE of a
 * session's placement identity (which group, under which name, with which
 * transcript id), plus a row when the tab closes.
 *
 * The renderer writes it by DIFFING its store (`lib/session-history.ts`), not
 * by hooking actions: a drag into a group, Cmd+G, an ungroup, a group deletion,
 * an agent's `clave_move_session`, an adoption after a restart all change the
 * same tuple and all land here without being named — and they land AT THE
 * MOVE, which is what the exchange-capture stream could not promise (its
 * events stamp the group as of the NEXT hook word, so a tab moved while idle
 * and then quit with the app was never recorded anywhere).
 *
 * No Electron imports: the directory is injected, so the ledger is testable
 * outside the app. Unbounded, like the capture store — a handful of rows per
 * session, never rewritten.
 */

export const LEDGER_VERSION = 1 as const

export type LedgerKind = 'placed' | 'closed'

/** What the renderer knows about a tab at the moment of the row. Every field
 *  is read from the store at stamp time, so a row keeps the names that were
 *  true when it was written (later renames write their own rows). */
export interface LedgerRow {
  v: typeof LEDGER_VERSION
  kind: LedgerKind
  /** Producer-side ISO timestamp. */
  ts: string
  /** Clave's tab id. */
  sessionId: string
  /** Claude Code's session id — the transcript stem — or null for tabs with
   *  no Claude transcript (plain terminals, other CLIs). */
  claudeSessionId: string | null
  name: string
  cwd: string
  mode: 'claude' | 'antigravity' | 'codex' | 'pi' | 'claude-agents' | 'terminal'
  model: string | null
  workspaceId: string | null
  groupId: string | null
  groupName: string | null
}

const KINDS: ReadonlySet<string> = new Set<LedgerKind>(['placed', 'closed'])
const MODES: ReadonlySet<string> = new Set([
  'claude',
  'antigravity',
  'codex',
  'pi',
  'claude-agents',
  'terminal'
])

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** Transcript ids are the file stems `locateTranscript` resolves: only the
 *  id alphabet is accepted, so a traversal string never enters the ledger. */
const CLAUDE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const NAME_MAX = 512
const CWD_MAX = 4096

/** Re-pick a row field by field: it crosses the IPC boundary from the
 *  renderer and must not smuggle extra keys — or the wrong shapes — into the
 *  file. Returns null when a required field is missing or malformed. */
export function normalizeLedgerRow(input: unknown): LedgerRow | null {
  if (!input || typeof input !== 'object') return null
  const r = input as Record<string, unknown>
  const kind = str(r.kind)
  const ts = str(r.ts)
  const sessionId = str(r.sessionId)
  const name = str(r.name)
  const cwd = str(r.cwd)
  const mode = str(r.mode)
  if (!kind || !KINDS.has(kind)) return null
  if (!ts || Number.isNaN(Date.parse(ts))) return null
  if (!sessionId || name === null || !cwd || !mode || !MODES.has(mode)) return null
  if (cwd.length > CWD_MAX) return null
  const claudeSessionId = str(r.claudeSessionId)
  return {
    v: LEDGER_VERSION,
    kind: kind as LedgerKind,
    ts,
    sessionId,
    claudeSessionId:
      claudeSessionId && CLAUDE_SESSION_ID.test(claudeSessionId) ? claudeSessionId : null,
    name: name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name,
    cwd,
    mode: mode as LedgerRow['mode'],
    model: str(r.model),
    workspaceId: str(r.workspaceId),
    groupId: str(r.groupId),
    groupName: str(r.groupName)
  }
}

export class SessionLedger {
  private readonly file: string

  constructor(dir: string) {
    this.file = path.join(dir, 'ledger.jsonl')
  }

  filePath(): string {
    return this.file
  }

  /** Append one row. Throws on an unwritable directory — the service turns
   *  that into a logged error, never into a failed store update. */
  append(row: LedgerRow): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf-8')
  }

  /** Every well-formed row, in file order. Unparseable or malformed lines are
   *  counted, never silently dropped; a missing file is an empty ledger. */
  readAll(): { rows: LedgerRow[]; skippedLines: number } {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch {
      return { rows: [], skippedLines: 0 }
    }
    const rows: LedgerRow[] = []
    let skippedLines = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        skippedLines++
        continue
      }
      const row = normalizeLedgerRow(parsed)
      if (row) rows.push(row)
      else skippedLines++
    }
    return { rows, skippedLines }
  }
}
