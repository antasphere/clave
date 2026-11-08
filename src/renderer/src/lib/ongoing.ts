import type { PiThinkingLevel } from '../../../shared/agent-launch'

/**
 * Ongoing conversations (PRDCT-4190): a conversation that is not task work but
 * a situation handled over weeks (the accountant, an email thread to fix) is
 * kept out of the sidebar, in a place of its own the sidebar's foot opens.
 *
 * An entry is the CONVERSATION, not the tab: it names the tab it lives in now,
 * and the provider's conversation id that brings it back once that tab's
 * process is gone (a reboot, a close). Nothing here moves a row: the tab keeps
 * its place in its group and in the order, and is only hidden while ongoing,
 * so putting it back in the sidebar returns it exactly where it was.
 *
 * Pure, so vitest pins it; the store is `store/ongoing-store.ts`, the actions
 * `lib/ongoing-actions.ts`.
 */

export type OngoingProvider = 'claude' | 'pi'

/** What a resume needs from the tab that held the conversation, taken when
 *  it was moved: the same fields the sidebar's own Resume carries. */
export interface OngoingLaunch {
  claudeAgentsMode?: boolean
  dangerousMode?: boolean
  model?: string
  launchProfileId?: string
  piProvider?: string
  piThinking?: PiThinkingLevel
  claudeProfileId?: string
  claudeProfileLabel?: string
  claudeConfigDir?: string
}

export interface OngoingEntry {
  /** Stable for the entry's life, whatever tab it lives in. */
  id: string
  /** The workspace the conversation belongs to; null = unscoped. */
  workspaceId: string | null
  /** The Clave tab the conversation lives in now. May name a tab that is
   *  gone: the conversation id below brings it back. */
  sessionId: string
  provider: OngoingProvider
  /** The provider's own conversation id (`claude --resume <id>`). */
  conversationId: string
  name: string
  cwd: string
  /** One line of the person's own: what this conversation is about. */
  note: string
  /** The group the tab sat in when it was moved, for the page's "from". */
  originGroup: { id: string; name: string } | null
  /** When it was moved here (epoch ms). */
  addedAt: number
  launch: OngoingLaunch
}

/** The fields of a session these rules read. */
export interface OngoingSessionLike {
  id: string
  name: string
  cwd: string
  alive: boolean
  claudeMode: boolean
  piMode?: boolean
  claudeAgentsMode?: boolean
  dangerousMode: boolean
  claudeSessionId: string | null
  piSessionId?: string | null
  sessionType: string
  workspaceId?: string
  model?: string
  launchProfileId?: string
  piProvider?: string
  piThinking?: PiThinkingLevel
  claudeProfileId?: string
  claudeProfileLabel?: string
  claudeConfigDir?: string
  agentState?: string
  promptWaiting?: string | null
  hasUnseenActivity?: boolean
}

/** The conversation a tab can be brought back to, or null when it never will
 *  (a terminal, a Codex or Antigravity tab: no resume Clave can drive). A
 *  Claude tab has its id from the spawn, before its first message. Only such a tab can
 *  become ongoing: a long-lived conversation that cannot come back after a
 *  reboot would be a promise the page could not keep. */
export function resumableConversation(
  s: OngoingSessionLike
): { provider: OngoingProvider; conversationId: string } | null {
  if (s.sessionType !== 'local' && s.sessionType !== 'remote-claude') return null
  if (s.piMode) return s.piSessionId ? { provider: 'pi', conversationId: s.piSessionId } : null
  if (s.claudeMode || s.claudeAgentsMode)
    return s.claudeSessionId ? { provider: 'claude', conversationId: s.claudeSessionId } : null
  return null
}

/** What a resume needs, as the tab holds it now. */
export function launchOf(s: OngoingSessionLike): OngoingLaunch {
  const launch: OngoingLaunch = {}
  if (s.claudeAgentsMode) launch.claudeAgentsMode = true
  if (s.dangerousMode) launch.dangerousMode = true
  if (s.model) launch.model = s.model
  if (s.launchProfileId) launch.launchProfileId = s.launchProfileId
  if (s.piProvider) launch.piProvider = s.piProvider
  if (s.piThinking) launch.piThinking = s.piThinking
  if (s.claudeProfileId) launch.claudeProfileId = s.claudeProfileId
  if (s.claudeProfileLabel) launch.claudeProfileLabel = s.claudeProfileLabel
  if (s.claudeConfigDir) launch.claudeConfigDir = s.claudeConfigDir
  return launch
}

/** The fields of a session record a resting conversation takes its launch
 *  from: the record is the last word on the account and the model the tab
 *  ran on (an account switch rewrites it), and the boot drops it. */
export interface OngoingRecordLike {
  id: string
  cwd?: string
  claudeSessionId?: string
  piSessionId?: string
  claudeAgentsMode?: boolean
  dangerousMode?: boolean
  model?: string
  launchProfileId?: string
  piProvider?: string
  piThinking?: PiThinkingLevel
  claudeProfileId?: string
  claudeProfileLabel?: string
  configDir?: string
}

export function launchOfRecord(r: OngoingRecordLike): OngoingLaunch {
  return launchOf({
    claudeAgentsMode: r.claudeAgentsMode,
    dangerousMode: !!r.dangerousMode,
    model: r.model,
    launchProfileId: r.launchProfileId,
    piProvider: r.piProvider,
    piThinking: r.piThinking,
    claudeProfileId: r.claudeProfileId,
    claudeProfileLabel: r.claudeProfileLabel,
    claudeConfigDir: r.configDir
  } as OngoingSessionLike)
}

export function sameLaunch(a: OngoingLaunch, b: OngoingLaunch): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof OngoingLaunch>
  for (const k of keys) if (a[k] !== b[k]) return false
  return true
}

export function entryFromSession(
  s: OngoingSessionLike,
  options: { id: string; now: number; originGroup: { id: string; name: string } | null }
): OngoingEntry | null {
  const conv = resumableConversation(s)
  if (!conv) return null
  return {
    id: options.id,
    workspaceId: s.workspaceId ?? null,
    sessionId: s.id,
    provider: conv.provider,
    conversationId: conv.conversationId,
    name: s.name,
    cwd: s.cwd,
    note: '',
    originGroup: options.originGroup,
    addedAt: options.now,
    launch: launchOf(s)
  }
}

/** The tab an entry lives in now: the one it names, else a tab running the
 *  same conversation (a resume from the history, a second window's copy). */
export function sessionOfEntry<S extends OngoingSessionLike>(
  entry: OngoingEntry,
  sessions: readonly S[]
): S | undefined {
  const byId = sessions.find((s) => s.id === entry.sessionId)
  if (byId) return byId
  return sessions.find((s) => {
    const conv = resumableConversation(s)
    return (
      conv !== null &&
      conv.provider === entry.provider &&
      conv.conversationId === entry.conversationId
    )
  })
}

/** Every tab the sidebar must not draw: the tabs of the given entries. */
export function ongoingSessionIds(
  entries: readonly OngoingEntry[],
  sessions: readonly OngoingSessionLike[]
): Set<string> {
  const ids = new Set<string>()
  for (const e of entries) {
    const s = sessionOfEntry(e, sessions)
    if (s) ids.add(s.id)
    // The named tab is hidden even before it shows up in this window's store
    // (a restore still attaching it), so it never flashes in as a row.
    ids.add(e.sessionId)
  }
  return ids
}

export function entriesInWorkspace(
  entries: readonly OngoingEntry[],
  workspaceId: string | null
): OngoingEntry[] {
  if (workspaceId === null) return [...entries]
  return entries.filter((e) => e.workspaceId === null || e.workspaceId === workspaceId)
}

/**
 * Where a conversation stands, as the page and the sidebar's foot say it:
 * - `waiting`: its agent asks the person something (a question, a permission);
 * - `working`: its agent is in a turn;
 * - `unread`: it said something nobody has looked at yet;
 * - `open`: its tab runs and has nothing new;
 * - `elsewhere`: its tab runs in another window; opening it brings it here;
 * - `resting`: no tab runs it; opening it resumes the conversation.
 */
export type OngoingStatus = 'waiting' | 'working' | 'unread' | 'open' | 'elsewhere' | 'resting'

export function statusOf(
  session: OngoingSessionLike | undefined,
  elsewhere = false
): OngoingStatus {
  if (!session || !session.alive) return elsewhere ? 'elsewhere' : 'resting'
  if (session.agentState === 'blocked' || session.promptWaiting) return 'waiting'
  if (session.agentState === 'working') return 'working'
  if (session.hasUnseenActivity) return 'unread'
  return 'open'
}

const STATUS_RANK: Record<OngoingStatus, number> = {
  waiting: 0,
  unread: 1,
  working: 2,
  open: 3,
  elsewhere: 4,
  resting: 5
}

/** The page's order: what asks for the person first, then what moved, then
 *  the rest by when it was kept, newest first. */
export function sortEntries<E extends { entry: OngoingEntry; status: OngoingStatus }>(
  rows: readonly E[]
): E[] {
  return [...rows].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.entry.addedAt - a.entry.addedAt
  )
}

/** The count the sidebar's foot carries beside the word: how many ask for the
 *  person (waiting or unread), else nothing to draw attention with. */
export function attentionCount(statuses: readonly OngoingStatus[]): number {
  return statuses.filter((s) => s === 'waiting' || s === 'unread').length
}

/**
 * The boot's split of the records whose process is gone: an ongoing tab is
 * never offered behind the restore prompt (it is not work to restore, and a
 * "No" there would lose it), nor spawned at launch (a dozen long-lived
 * conversations would start a dozen agents nobody asked for). Its record is
 * dropped and the entry brings the conversation back when it is opened.
 */
export function splitOngoingDead<R extends OngoingRecordLike>(
  deadTabs: readonly R[],
  entries: readonly OngoingEntry[]
): { restore: R[]; resting: R[]; entries: OngoingEntry[] } {
  const restore: R[] = []
  const resting: R[] = []
  let next = [...entries]
  for (const r of deadTabs) {
    const i = next.findIndex(
      (e) =>
        e.sessionId === r.id ||
        (e.provider === 'claude' &&
          !!r.claudeSessionId &&
          e.conversationId === r.claudeSessionId) ||
        (e.provider === 'pi' && !!r.piSessionId && e.conversationId === r.piSessionId)
    )
    if (i === -1) {
      restore.push(r)
      continue
    }
    resting.push(r)
    // The record goes; what it knew of the launch stays with the entry, but
    // only the record of the tab the entry names: an older record of the
    // same conversation holds the launch it had then.
    const e = next[i]
    if (r.id !== e.sessionId) continue
    const launch = launchOfRecord(r)
    const cwd = r.cwd || e.cwd
    if (!sameLaunch(launch, e.launch) || cwd !== e.cwd) {
      next = next.map((x, j) => (j === i ? { ...e, launch, cwd } : x))
    }
  }
  return { restore, resting, entries: next }
}

/** A relative time the page writes ("just now", "5 min ago", "3 days ago"). */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  if (d < 14) return d === 1 ? 'yesterday' : `${d} days ago`
  const w = Math.round(d / 7)
  if (d < 60) return `${w} weeks ago`
  const mo = Math.round(d / 30)
  return mo <= 1 ? 'a month ago' : `${mo} months ago`
}
