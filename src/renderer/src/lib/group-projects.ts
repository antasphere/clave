/**
 * The group that names itself (PRDCT-5179). A group a person makes comes up
 * as « Group N » at once and never waits; its agent tabs are then read by
 * the server that owns them (`readTabProjects`: Jev, with that server's key,
 * each answer kept on the tab's record), and what the group does with the
 * answers is ONE pure rule, `readGroupProjects` of the contract:
 *
 * - `named`: the group takes that name, as Clave's own rename (the flag
 *   stays, no undo step) and its suggestion goes;
 * - `suggested`: the group keeps its name, and its row offers the two nearest
 *   projects (`store/group-suggestions-store.ts`);
 * - `unread`: nothing, and a suggestion it had goes.
 *
 * Only a group whose `autoNamed` flag holds is ever read: a name a person,
 * an agent or a pin gave is theirs for good. An answer that comes back for a
 * group gone, or no longer `autoNamed`, is dropped, and the rule reads the
 * group's tabs as they are THEN, not as they were when asked. Any failure
 * leaves the group exactly as it is: no toast, no dialog.
 *
 * When: right after a person groups tabs (`groupTabsByPerson`), and when the
 * tabs of an `autoNamed` group change (`startGroupNaming`: one subscription,
 * debounced per group, its baseline the state it starts on, so nothing is
 * read at boot). Never on a timer.
 */
import { readGroupProjects, type TabProjects } from '@clave/contract/tab-projects-rules'
import { useSessionStore } from '../store/session-store'
import type { Session, SessionGroup } from '../store/session-types'
import { clearGroupSuggestion, setGroupSuggestion } from '../store/group-suggestions-store'

/** What one call answers: each tab's reading as its record now keeps it. */
export interface TabProjectsAnswer {
  tabs: ReadonlyArray<{ sessionId: string; projects: TabProjects | null }>
}
export type ReadTabProjects = (sessionIds: string[]) => Promise<TabProjectsAnswer>

/** The most tabs one call may name (`READ_TAB_PROJECTS_MAX` of
 *  `@clave/contract/decisions`, which the renderer does not import: it
 *  brings the HTTP framework with it). */
const READ_MAX = 50

/** How long a group's tabs must hold still before they are read again. */
export const GROUP_NAMING_DEBOUNCE_MS = 300

const defaultRead: ReadTabProjects = (sessionIds) => window.electronAPI.readTabProjects(sessionIds)

/** The tabs of a group a decision can read: its agent tabs of Claude Code,
 *  Codex or Pi, never its quick-launch terminals. */
export function agentTabIds(group: SessionGroup, sessions: ReadonlyArray<Session>): string[] {
  const terminals = new Set(group.terminals.map((t) => t.sessionId).filter((id) => !!id))
  const byId = new Map<string, Session>(sessions.map((s) => [s.id, s]))
  return group.sessionIds.filter((id) => {
    if (terminals.has(id)) return false
    const s = byId.get(id)
    return !!s && (s.claudeMode || s.codexMode || s.piMode === true)
  })
}

/** Each group's latest call: an answer to an older one is dropped. */
const generations = new Map<string, number>()

/**
 * Read a group's tabs and do what `readGroupProjects` says. Resolves once
 * done; never rejects.
 */
export async function nameGroupFromTabs(
  groupId: string,
  read: ReadTabProjects = defaultRead
): Promise<void> {
  try {
    const before = useSessionStore.getState()
    const group = before.groups.find((g) => g.id === groupId)
    if (!group?.autoNamed) return
    const ids = agentTabIds(group, before.sessions).slice(0, READ_MAX)
    // No tab a decision reads: nothing to ask, and nothing left to offer.
    if (ids.length === 0) return applyGroupReading(groupId)
    const generation = (generations.get(groupId) ?? 0) + 1
    generations.set(groupId, generation)
    const answer = await read(ids)
    if (generations.get(groupId) !== generation) return
    const store = useSessionStore.getState()
    for (const tab of answer.tabs) store.applyServedProjects(tab.sessionId, tab.projects)
    applyGroupReading(groupId)
  } catch {
    // The group stays exactly as it is.
  }
}

/** What a group's tabs, as they are now, say of it. */
function applyGroupReading(groupId: string): void {
  const state = useSessionStore.getState()
  const group = state.groups.find((g) => g.id === groupId)
  if (!group?.autoNamed) return
  const byId = new Map<string, Session>(state.sessions.map((s) => [s.id, s]))
  const reading = readGroupProjects(
    agentTabIds(group, state.sessions).map((id) => byId.get(id)?.projects)
  )
  if (reading.status === 'named') {
    state.renameGroup(groupId, reading.name, { auto: true })
    clearGroupSuggestion(groupId)
  } else if (reading.status === 'suggested') setGroupSuggestion(groupId, reading.nearest)
  else clearGroupSuggestion(groupId)
}

/** A person groups tabs (the keymap's `groupSelectedSessions`, the
 *  sidebar's « Group »): the group comes up as « Group N » at once, and its
 *  tabs are read after. */
export function groupTabsByPerson(
  sessionIds: string[],
  read: ReadTabProjects = defaultRead
): string | undefined {
  const groupId = useSessionStore
    .getState()
    .createGroup(sessionIds, undefined, undefined, { autoNamed: true })
  if (groupId) void nameGroupFromTabs(groupId, read)
  return groupId
}

/**
 * Read an `autoNamed` group's tabs again when they change: a tab joins it,
 * or a tab of it is closed or moved out. A member the store never held
 * leaving it (a shell the boot restore prunes) is not a change. The state
 * the subscription starts on is its baseline, and a group that appears
 * after is taken as it comes (its maker reads it), so nothing is read at
 * boot. Answers the way to stop.
 */
export function startGroupNaming(
  options: { read?: ReadTabProjects; debounceMs?: number } = {}
): () => void {
  const read = options.read ?? defaultRead
  const debounceMs = options.debounceMs ?? GROUP_NAMING_DEBOUNCE_MS
  const seen = new Map<string, string[]>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const cancel = (groupId: string): void => {
    const timer = timers.get(groupId)
    if (timer) clearTimeout(timer)
    timers.delete(groupId)
  }
  const schedule = (groupId: string): void => {
    cancel(groupId)
    timers.set(
      groupId,
      setTimeout(() => {
        timers.delete(groupId)
        void nameGroupFromTabs(groupId, read)
      }, debounceMs)
    )
  }
  const initial = useSessionStore.getState()
  for (const g of initial.groups) if (g.autoNamed) seen.set(g.id, [...g.sessionIds])
  let held = new Set(initial.sessions.map((s) => s.id))

  const unsubscribe = useSessionStore.subscribe((state, previous) => {
    if (state.groups === previous.groups && state.sessions === previous.sessions) return
    const live = new Set<string>()
    for (const g of state.groups) {
      if (!g.autoNamed) continue
      live.add(g.id)
      const before = seen.get(g.id)
      seen.set(g.id, [...g.sessionIds])
      if (!before) continue
      const now = new Set(g.sessionIds)
      const joined = g.sessionIds.some((id) => !before.includes(id))
      const left = before.some((id) => !now.has(id) && held.has(id))
      if (joined || left) schedule(g.id)
    }
    for (const id of [...seen.keys()]) {
      if (live.has(id)) continue
      // Gone, or named by someone else: nothing more to read or to offer.
      seen.delete(id)
      cancel(id)
      clearGroupSuggestion(id)
    }
    held = new Set(state.sessions.map((s) => s.id))
  })
  return () => {
    unsubscribe()
    for (const id of [...timers.keys()]) cancel(id)
  }
}
