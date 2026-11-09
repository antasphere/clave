/**
 * What the agent tools know of past conversations (PRDCT-4236): the rows of
 * the History dialog for `clave_history`, and how `clave_open_session` with a
 * `resume` finds the conversation it is asked to reopen. On 9 November 2026
 * Romain clicked eleven titles in the History dialog himself because no tool
 * could reopen a conversation from its transcript; the dialog's own rules
 * live here now, over injected lookups (the History service, the server's
 * records and sessions, the workspaces), so both tools answer as the dialog
 * does and a unit test reaches every rule on fakes.
 *
 * The rules, the dialog's (`SessionHistoryDialog`, `resumeHistoryEntry`):
 * a conversation is resumable when its provider resumes (Claude, Codex and
 * Pi; Antigravity does not), its transcript is on disk and it names a working
 * directory; a conversation a LIVE tab already runs is never started again,
 * that tab is the answer; a conversation a STOPPED tab still holds is resumed
 * in that tab rather than beside it, so the sidebar never carries two tabs of
 * one conversation.
 */
import type { Session, SessionRecord } from '@clave/contract/sessions'
import type { HistoryListEntry } from '../session-history/service'

export interface HistoryLookups {
  /** The History dialog's rows: the ledger's conversations and the stores' transcripts. */
  history(): HistoryListEntry[]
  /** The server's adoptable records, the sessions it runs marked `running`. */
  records(): Promise<readonly SessionRecord[]>
  /** The server's sessions, stopped records included, with their state. */
  sessions(): Promise<readonly Session[]>
  /** The registered workspaces, for the rows' names. */
  workspaces(): ReadonlyArray<{ id: string; name: string }>
}

/** One row of `clave_history`: what the dialog shows, and whether a tab has it open. */
export interface HistoryRow {
  conversationId: string
  provider: HistoryListEntry['provider']
  title: string
  cwd: string
  model: string | null
  workspaceId: string | null
  workspaceName: string | null
  /** The sidebar groups the conversation sat in, by name, as the ledger saw them. */
  groups: string[]
  /** The last human message, else the last sighting, ISO. */
  lastActivity: string
  transcriptExists: boolean
  /** Whether `clave_open_session` with `resume` can reopen it. */
  resumable: boolean
  /** The tab that holds this conversation, when one does: alive while its
   *  process runs, stopped otherwise (Resume brings it back). */
  open: { sessionId: string; alive: boolean } | null
}

export interface HistoryFilter {
  /** A case-insensitive substring of the title, the tab's name or the directory. */
  query?: string
  /** A workspace id or exact name (case-insensitive). */
  workspace?: string
  provider?: string
  /** Rows at most, newest first; 50 when absent, 200 at most. */
  limit?: number
  /** Only conversations a tab has open (alive or stopped). */
  open?: boolean
}

const RESUMABLE = new Set<HistoryListEntry['provider']>(['claude', 'codex', 'pi'])
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** The tabs that hold a conversation, by its provider id, over the server's
 *  records and sessions: alive when the host runs it and its state is not
 *  ended, stopped otherwise. An alive holder wins over a stopped one. */
export function holdersOf(
  records: readonly SessionRecord[],
  sessions: readonly Session[]
): Map<string, { sessionId: string; alive: boolean }> {
  const state = new Map(sessions.map((s) => [s.id, s.state]))
  const out = new Map<string, { sessionId: string; alive: boolean }>()
  for (const r of records) {
    const conversation = r.claudeSessionId ?? r.codexThreadId ?? r.piSessionId
    if (!conversation) continue
    const alive = r.running === true && state.get(r.id) !== 'ended'
    const known = out.get(conversation)
    if (!known || (alive && !known.alive)) out.set(conversation, { sessionId: r.id, alive })
  }
  return out
}

function matchesWorkspace(
  entry: HistoryListEntry,
  ref: string,
  workspaces: ReadonlyArray<{ id: string; name: string }>
): boolean {
  const lowered = ref.toLowerCase()
  const ws = workspaces.find((w) => w.id === ref || w.name.toLowerCase() === lowered)
  return ws ? entry.workspaceId === ws.id : false
}

/** The rows of the History, filtered and newest first. */
export async function listConversations(
  lookups: HistoryLookups,
  filter: HistoryFilter = {}
): Promise<{ rows: HistoryRow[]; total: number }> {
  const [records, sessions] = await Promise.all([lookups.records(), lookups.sessions()])
  const holders = holdersOf(records, sessions)
  const workspaces = lookups.workspaces()
  const names = new Map(workspaces.map((w) => [w.id, w.name]))
  const query = filter.query?.trim().toLowerCase()
  const provider = filter.provider?.trim().toLowerCase()
  const rows = lookups
    .history()
    .filter((e) => !provider || e.provider === provider)
    .filter((e) => !filter.workspace || matchesWorkspace(e, filter.workspace, workspaces))
    .filter(
      (e) =>
        !query ||
        e.title.toLowerCase().includes(query) ||
        e.name.toLowerCase().includes(query) ||
        e.cwd.toLowerCase().includes(query)
    )
    .map((e): HistoryRow => {
      const open = holders.get(e.claudeSessionId) ?? null
      return {
        conversationId: e.claudeSessionId,
        provider: e.provider,
        title: e.title,
        cwd: e.cwd,
        model: e.model ?? null,
        workspaceId: e.workspaceId,
        workspaceName: e.workspaceId ? (names.get(e.workspaceId) ?? null) : null,
        groups: e.groups.map((g) => g.name),
        lastActivity: e.lastHumanAt,
        transcriptExists: e.transcript.exists,
        resumable: RESUMABLE.has(e.provider) && e.transcript.exists && !!e.cwd,
        open
      }
    })
    .filter((r) => filter.open !== true || r.open !== null)
    .sort((a, b) =>
      a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0
    )
  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  return { rows: rows.slice(0, limit), total: rows.length }
}

/** What `clave_open_session` with `resume` does with the conversation. */
export type ResumePlan =
  /** A live tab runs it: that tab is the answer, never a second process. */
  | { kind: 'open'; sessionId: string }
  /** A stopped tab still holds it: resumed there, under its own id. */
  | { kind: 'stopped'; sessionId: string }
  /** Nothing holds it: a new tab on the conversation, in its directory. */
  | {
      kind: 'start'
      cwd: string
      provider: 'claude' | 'codex' | 'pi'
      title: string
      model: string | null
      workspaceId: string | null
    }

export class ResumeRefused extends Error {}

/**
 * The plan for a conversation id, with the dialog's refusals said in words:
 * unknown to the History, a provider that does not resume, a transcript that
 * is gone, no working directory, a working directory that no longer exists.
 */
export async function planResume(
  lookups: HistoryLookups,
  conversationId: string,
  dirExists: (path: string) => boolean
): Promise<ResumePlan> {
  const id = conversationId.trim()
  if (!id) throw new ResumeRefused('resume names no conversation id.')
  const [records, sessions] = await Promise.all([lookups.records(), lookups.sessions()])
  const holder = holdersOf(records, sessions).get(id)
  if (holder?.alive) return { kind: 'open', sessionId: holder.sessionId }
  if (holder) return { kind: 'stopped', sessionId: holder.sessionId }
  const entry = lookups.history().find((e) => e.claudeSessionId === id)
  if (!entry)
    throw new ResumeRefused(
      `No conversation "${id}" in the History. clave_history lists the conversations and their ids.`
    )
  if (!RESUMABLE.has(entry.provider))
    throw new ResumeRefused(`Conversation "${id}" is ${entry.provider}'s, which cannot be resumed.`)
  if (!entry.transcript.exists)
    throw new ResumeRefused(
      `The transcript of conversation "${id}" ("${entry.title}") is gone; there is nothing to resume.`
    )
  if (!entry.cwd)
    throw new ResumeRefused(
      `Conversation "${id}" ("${entry.title}") names no working directory; it cannot be resumed. Pass cwd to open it there.`
    )
  if (!dirExists(entry.cwd))
    throw new ResumeRefused(
      `The working directory of conversation "${id}" ("${entry.title}"), ${entry.cwd}, no longer exists. Pass cwd to open it elsewhere.`
    )
  return {
    kind: 'start',
    cwd: entry.cwd,
    provider: entry.provider as 'claude' | 'codex' | 'pi',
    title: entry.title,
    model: entry.model ?? null,
    workspaceId: entry.workspaceId
  }
}

/**
 * The same plan on a Clave server, which keeps no History: its own records
 * are what it knows of past conversations. A live holder is the answer, a
 * stopped one is resumed in place, and anything else starts fresh on the id
 * in the directory the caller names (the server cannot tell a transcript it
 * has from one it has not until it starts).
 */
export function planResumeFromRecords(
  records: readonly SessionRecord[],
  sessions: readonly Session[],
  conversationId: string
): { kind: 'open'; sessionId: string } | { kind: 'stopped'; sessionId: string } | null {
  const holder = holdersOf(records, sessions).get(conversationId.trim())
  if (!holder) return null
  return holder.alive
    ? { kind: 'open', sessionId: holder.sessionId }
    : { kind: 'stopped', sessionId: holder.sessionId }
}
