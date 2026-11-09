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
import type { LedgerLaunch } from '../session-history/ledger'
import { runtimeChoices } from '../../shared/runtime-choices'

export interface HistoryLookups {
  /** The History dialog's rows: the ledger's conversations and the stores' transcripts. */
  history(): HistoryListEntry[] | Promise<HistoryListEntry[]>
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
  /** What it was last launched on, as the ledger remembers (PRDCT-4236):
   *  bypass, the mode and the effort it ran at, the account. A resume
   *  defaults to it. Absent when the ledger never saw it launched. */
  launch?: LedgerLaunch
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

/** How many ids one by-id records read carries: they travel in a query
 *  string, and a Mac with hundreds of ended sessions must not overflow it
 *  (round 2, N-F4). */
export const RECORDS_BY_ID_CHUNK = 40

/**
 * The records the holders are read from: the listing a window restores from,
 * plus, by id, the records of every session the host lists that the listing
 * lacks (a hosted session whose process has ended is left out of the listing
 * and still holds its conversation, round 1 F2), a chunk at a time. A read
 * that fails is said, never swallowed: a quiet fallback would bring the
 * duplicate tab back without a word.
 */
export async function recordsWithStopped(
  listAdoptable: (ids?: ReadonlyArray<string>) => Promise<ReadonlyArray<SessionRecord>>,
  list: () => Promise<ReadonlyArray<Session>>
): Promise<readonly SessionRecord[]> {
  const listed = await listAdoptable()
  const ids = new Set(listed.map((r) => r.id))
  const missing = (await list()).map((s) => s.id).filter((id) => !ids.has(id))
  if (missing.length === 0) return listed
  const more: SessionRecord[] = []
  for (let at = 0; at < missing.length; at += RECORDS_BY_ID_CHUNK)
    more.push(...(await listAdoptable(missing.slice(at, at + RECORDS_BY_ID_CHUNK))))
  return [...listed, ...more.filter((r) => !ids.has(r.id))]
}

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
  const rows = (await lookups.history())
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
        open,
        ...(e.launch ? { launch: e.launch } : {})
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
      /** A Pi conversation's provider and thinking level, as the History knows them. */
      piProvider: string | null
      piThinking: string | null
      /** What it was last launched on, as the ledger remembers (PRDCT-4236). */
      launch: LedgerLaunch | null
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
  dirExists: (path: string) => boolean,
  /** A directory the caller named: the conversation opens there, whatever
   *  its transcript says (a directory moved or gone, round 1 F4). */
  callerCwd?: string
): Promise<ResumePlan> {
  const id = conversationId.trim()
  if (!id) throw new ResumeRefused('resume names no conversation id.')
  const [records, sessions] = await Promise.all([lookups.records(), lookups.sessions()])
  const holder = holdersOf(records, sessions).get(id)
  if (holder?.alive) return { kind: 'open', sessionId: holder.sessionId }
  if (holder) return { kind: 'stopped', sessionId: holder.sessionId }
  const entry = (await lookups.history()).find((e) => e.claudeSessionId === id)
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
  if (!callerCwd && !entry.cwd)
    throw new ResumeRefused(
      `Conversation "${id}" ("${entry.title}") names no working directory; it cannot be resumed. Pass cwd to open it there.`
    )
  if (!callerCwd && !dirExists(entry.cwd))
    throw new ResumeRefused(
      `The working directory of conversation "${id}" ("${entry.title}"), ${entry.cwd}, no longer exists. Pass cwd to open it elsewhere.`
    )
  return {
    kind: 'start',
    cwd: callerCwd || entry.cwd,
    provider: entry.provider as 'claude' | 'codex' | 'pi',
    title: entry.title,
    model: entry.model ?? null,
    workspaceId: entry.workspaceId,
    piProvider: entry.agentProvider ?? null,
    piThinking: entry.thinking ?? null,
    launch: entry.launch ?? null
  }
}

/** What `openResumed` asks of the host. */
export interface ResumeOpenIo {
  isDirectory(path: string): boolean
  /** Whether a workspace id is registered, so a conversation's workspace is
   *  named only when the open can land in it. */
  isRegisteredWorkspace(id: string): boolean
  /** The Resume the person's button makes, under the tab's own id. */
  restart(sessionId: string): Promise<{ resumed: boolean }>
  /** Shows the tab, as the dialog shows the one it found; a failure here
   *  never undoes the answer. */
  focus(sessionId: string): Promise<void>
  /** Whether an account id still exists on this Mac, so a remembered
   *  account is named only when the open can run on it (PRDCT-4236). */
  isKnownAccount(provider: 'claude' | 'codex', id: string): boolean
}

/**
 * The launch a resume defaults to (PRDCT-4236): what the ledger remembers,
 * under the Resume's own rule (`runtimeChoices`), the caller's every value
 * winning. A caller's `dangerous` decides bypass, and then no remembered
 * mode is passed; a caller's `permissionMode` likewise stands alone. An
 * account is named only when it still exists, else the pool picks, as
 * before. Claude takes the mode; Claude and Codex take bypass, the effort and
 * the account; Pi takes none of them.
 */
export function resumeLaunchDefaults(
  plan: { provider: 'claude' | 'codex' | 'pi'; launch: LedgerLaunch | null },
  p: Record<string, unknown>,
  isKnownAccount: ResumeOpenIo['isKnownAccount']
): Record<string, unknown> {
  const launch = plan.launch
  if (!launch || plan.provider === 'pi') return {}
  const callerChoseMode = p.dangerous !== undefined || p.permissionMode !== undefined
  const choices = runtimeChoices({
    dangerousMode: launch.dangerous === true,
    permissionMode: launch.permissionMode,
    effort: launch.effort
  })
  const out: Record<string, unknown> = {}
  if (!callerChoseMode) {
    if (launch.dangerous !== undefined || launch.permissionMode !== undefined)
      out.dangerous = choices.dangerousMode
    if (plan.provider === 'claude' && choices.permissionMode) {
      out.permissionMode = choices.permissionMode
      if (choices.allowDangerous) out.allowDangerous = true
    }
  }
  if (p.effort === undefined && choices.effort) out.effort = choices.effort
  if (
    p.account === undefined &&
    launch.accountId &&
    isKnownAccount(plan.provider, launch.accountId)
  )
    out.account = launch.accountId
  return out
}

/**
 * `clave_open_session` with `resume`, the whole decision (round 1, E2: it
 * lived in the tool's host and no test reached it): a live holder is focused
 * and answered, never a second process; a stopped holder is resumed in place,
 * which needs a tab identity as `clave_resume_session` does (round 1, F5);
 * otherwise the open goes on with the conversation's own directory,
 * provider, model, title and Pi settings filled in where the caller named
 * none, and `resumeSessionId` for the spawn. The caller's `mode`, when it
 * names one, must be the conversation's provider (round 1, F1: a default
 * filled in by the schema is not a choice, so the schema fills none).
 */
export async function openResumed(
  lookups: HistoryLookups,
  p: Record<string, unknown>,
  caller: string | undefined,
  io: ResumeOpenIo
): Promise<{ result: unknown } | { payload: Record<string, unknown> }> {
  const resume = String(p.resume).trim()
  if (p.server !== undefined)
    throw new ResumeRefused(
      'resume reopens a conversation of this Mac; omit server. A stopped tab on a Clave server is resumed with clave_resume_session.'
    )
  const callerCwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : undefined
  const plan = await planResume(lookups, resume, io.isDirectory, callerCwd)
  if (plan.kind === 'open' || plan.kind === 'stopped') {
    let resumed = false
    if (plan.kind === 'stopped') {
      if (!caller)
        throw new ResumeRefused(
          'clave_open_session with resume of a stopped tab must be called from inside a Clave agent tab — this request has no tab identity. clave_history says which tab holds the conversation.'
        )
      resumed = (await io.restart(plan.sessionId)).resumed
    }
    await io.focus(plan.sessionId).catch(() => {})
    return {
      result: {
        sessionId: plan.sessionId,
        groupId: null,
        conversation: resume,
        alreadyOpen: true,
        resumed,
        note:
          plan.kind === 'open'
            ? 'A tab already runs this conversation; it was focused and nothing was started.'
            : 'A stopped tab held this conversation; it was resumed in place.'
      }
    }
  }
  const mode = typeof p.mode === 'string' ? p.mode : undefined
  if (mode !== undefined && mode !== plan.provider)
    throw new ResumeRefused(
      `Conversation "${resume}" is ${plan.provider}'s; mode "${mode}" cannot resume it. Omit mode or pass "${plan.provider}".`
    )
  const workspace =
    p.workspace === undefined && plan.workspaceId && io.isRegisteredWorkspace(plan.workspaceId)
      ? { workspace: plan.workspaceId }
      : {}
  const pi =
    plan.provider === 'pi'
      ? {
          ...(p.provider === undefined && plan.piProvider ? { provider: plan.piProvider } : {}),
          ...(p.thinking === undefined && plan.piThinking ? { thinking: plan.piThinking } : {})
        }
      : {}
  return {
    payload: {
      ...p,
      mode: plan.provider,
      cwd: plan.cwd,
      ...(p.model === undefined && plan.model ? { model: plan.model } : {}),
      ...(p.name === undefined ? { name: plan.title } : {}),
      ...workspace,
      ...pi,
      ...resumeLaunchDefaults(plan, p, io.isKnownAccount),
      resumeSessionId: resume
    }
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
