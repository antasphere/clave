import { useSessionStore } from '../store/session-store'
import { useOngoingStore, newOngoingId, announceEnded } from '../store/ongoing-store'
import { accountSessionFields, accountSpawnFields } from '../store/claude-profile-store'
import { emitTabClosed } from './exchange-capture'
import { isRemoteKey, ownerOf } from './fleet-identity'
import {
  conversationConfigDir,
  entryFromSession,
  launchOf,
  ongoingSessionIds,
  resumableConversation,
  sameLaunch,
  sessionOfEntry,
  type OngoingEntry
} from './ongoing'
import type { Session } from '../store/session-types'

/**
 * What the person does with an ongoing conversation (PRDCT-4190): move tabs
 * in, open one, put one back in the sidebar, end one. The rules are
 * `lib/ongoing.ts`; this is where they meet the session store and main.
 */

/** Whether the tab's menu offers "Move to Ongoing". */
export function canMoveToOngoing(session: Session | undefined): boolean {
  return !!session && resumableConversation(session) !== null
}

/** Move tabs to Ongoing. Their rows leave the sidebar and keep their place,
 *  hidden, in their group; a tab that cannot come back after its process
 *  ends (no conversation to resume) is left where it is. Returns the ids
 *  moved. */
export function moveToOngoing(sessionIds: string[]): string[] {
  const state = useSessionStore.getState()
  const existing = useOngoingStore.getState().entries
  const already = ongoingSessionIds(existing, state.sessions)
  const now = Date.now()
  const added: OngoingEntry[] = []
  for (const id of sessionIds) {
    if (already.has(id)) continue
    const session = state.sessions.find((s) => s.id === id)
    if (!session) continue
    const group = state.groups.find((g) => g.sessionIds.includes(id))
    const entry = entryFromSession(session, {
      id: newOngoingId(),
      now,
      originGroup: group ? { id: group.id, name: group.name } : null
    })
    if (entry) added.push(entry)
  }
  if (added.length === 0) return []
  const movedIds = new Set(added.map((e) => e.sessionId))
  void useOngoingStore
    .getState()
    .update((entries) => [...added.filter((a) => !entries.some((e) => e.id === a.id)), ...entries])
  // A moved tab no longer reads as selected: the pane would otherwise keep
  // showing the conversation the person just put away.
  const selected = state.selectedSessionIds.filter((id) => !movedIds.has(id))
  if (selected.length !== state.selectedSessionIds.length) {
    if (selected.length > 0) useSessionStore.getState().selectSessions(selected)
    else useSessionStore.setState({ selectedSessionIds: [], focusedSessionId: null })
  }
  return [...movedIds]
}

/** Whether the Claude conversation has a transcript to resume from. Read on
 *  this Mac only: a conversation of a server tab is that server's to find,
 *  and a read that fails counts as there, so the resume is tried as before. */
async function hasClaudeTranscript(entry: OngoingEntry): Promise<boolean> {
  if (isRemoteKey(entry.sessionId)) return true
  const read = window.electronAPI?.historyConversation
  if (!read) return true
  try {
    const res = await read(entry.cwd, entry.conversationId, 'claude', conversationConfigDir(entry))
    return res.exists
  } catch {
    return true
  }
}

/** Bring a resting conversation back in a new tab and return its id. The
 *  entry names the new tab BEFORE the tab is added, so the row never shows
 *  in the sidebar while it starts. */
async function resumeEntry(entry: OngoingEntry, keepOngoing: boolean): Promise<string | null> {
  const store = useSessionStore.getState()
  const dead = sessionOfEntry<Session>(entry, store.sessions)
  const isPi = entry.provider === 'pi'
  const isAgents = !!entry.launch.claudeAgentsMode
  const dangerousMode = isPi ? false : !!entry.launch.dangerousMode
  try {
    // A Claude tab moved before it ever spoke has an id and no transcript:
    // its resume would fail, so it starts fresh under that same id (F7).
    const fresh = !isPi && !(await hasClaudeTranscript(entry))
    const info = await window.electronAPI.fleetStart(ownerOf(entry.sessionId), entry.cwd, {
      claudeMode: !isAgents && !isPi,
      claudeAgentsMode: isAgents,
      piMode: isPi,
      dangerousMode,
      model: entry.launch.model,
      launchProfileId: entry.launch.launchProfileId,
      piProvider: entry.launch.piProvider,
      piThinking: entry.launch.piThinking,
      ...(fresh
        ? { claudeSessionId: entry.conversationId }
        : { resumeSessionId: entry.conversationId }),
      ...(isPi ? {} : accountSpawnFields(entry.launch)),
      workspaceId: entry.workspaceId ?? undefined
    })
    if (keepOngoing) {
      const conversationId =
        (isPi ? info.piSessionId : info.claudeSessionId) || entry.conversationId
      // Synchronous on the window's copy: the new tab is hidden before it is added.
      void useOngoingStore
        .getState()
        .update((entries) =>
          entries.map((e) => (e.id === entry.id ? { ...e, sessionId: info.id, conversationId } : e))
        )
    }
    const session: Session = {
      id: info.id,
      cwd: info.cwd,
      folderName: info.folderName,
      name: entry.name || info.folderName,
      alive: info.alive,
      activityStatus: 'idle',
      promptWaiting: null,
      claudeMode: !isAgents && !isPi,
      claudeAgentsMode: isAgents,
      antigravityMode: false,
      codexMode: false,
      piMode: isPi,
      dangerousMode,
      model: info.model,
      workspaceId: entry.workspaceId ?? undefined,
      claudeSessionId: info.claudeSessionId,
      piSessionId: info.piSessionId,
      launchProfileId: info.launchProfileId,
      piProvider: info.piProvider,
      piThinking: info.piThinking,
      ...(isPi ? {} : accountSessionFields(entry.launch)),
      sessionType: 'local',
      detectedUrl: null,
      serverStatus: null,
      serverCommand: null,
      hasUnseenActivity: false,
      userRenamed: true,
      planFilePath: null
    }
    // A dead tab still in the store (its process ended while the app ran)
    // gives its place to the new one: same group, same spot.
    const group = dead ? store.groups.find((g) => g.sessionIds.includes(dead.id)) : undefined
    // Else the group it came from, when it still runs: hidden there while it
    // is ongoing, so "Back to the sidebar" puts it back where it was.
    const origin =
      !group && entry.originGroup
        ? store.groups.find((g) => g.id === entry.originGroup!.id)
        : undefined
    useSessionStore.getState().addSessionInGroup(session, (group ?? origin)?.id ?? null)
    if (dead && !dead.alive) {
      // Its record goes with it: a second record of the conversation would
      // be read at the next boot as well, with the launch it had then.
      const records = await window.electronAPI
        .listSessionRecords({ ids: [dead.id] })
        .catch(() => [])
      for (const r of records) void window.electronAPI.discardSessionRecord?.(r.tmuxName ?? r.id)
      useSessionStore.getState().removeSession(dead.id)
    }
    return info.id
  } catch (err) {
    console.error('Could not resume the ongoing conversation:', err)
    return null
  }
}

/** One action at a time per conversation: a second click (or a menu's click
 *  reaching the card under it) while a resume is starting must never start a
 *  second agent on the same conversation. A second open is dropped; an End
 *  or a Back (`wait`) runs once the action in flight is over (R2-F4), and
 *  after `WAIT_MS` at most, so an action that never answers cannot block
 *  the conversation until a reload. */
const busy = new Map<string, Promise<unknown>>()
export const WAIT_MS = 10_000
async function exclusive<T>(
  entryId: string,
  run: () => Promise<T>,
  wait = false
): Promise<T | null> {
  const until = Date.now() + WAIT_MS
  // Checked again after every wake: a second waiter that woke first holds it.
  while (busy.has(entryId)) {
    if (!wait) return null
    const left = until - Date.now()
    if (left <= 0) break
    await Promise.race([
      busy.get(entryId)!.catch(() => {}),
      new Promise((r) => setTimeout(r, left))
    ])
  }
  const own = run()
  busy.set(entryId, own)
  try {
    return await own
  } finally {
    if (busy.get(entryId) === own) busy.delete(entryId)
  }
}

/** The entries' tabs that run in ANOTHER window of this Mac, by tab id: that
 *  window's store holds them, this one's does not. Read off their records (a
 *  read by id answers whatever the window), which name the window they live
 *  in. */
async function tabsElsewhere(
  entries: readonly OngoingEntry[]
): Promise<{ ids: Set<string>; myWindowId: number | null }> {
  const ids = new Set<string>()
  const local = entries.filter((e) => !isRemoteKey(e.sessionId))
  if (local.length === 0) return { ids, myWindowId: null }
  const api = window.electronAPI
  const [records, mine] = await Promise.all([
    api.listSessionRecords({ ids: local.map((e) => e.sessionId) }).catch(() => []),
    api.windowIdentity().catch(() => null)
  ])
  if (!mine) return { ids, myWindowId: null }
  const here = useSessionStore.getState().sessions
  for (const r of records) {
    if (r.live === false || !r.windowKey || r.windowKey === mine.windowKey) continue
    if (here.some((s) => s.id === r.id)) continue
    ids.add(r.id)
  }
  return { ids, myWindowId: mine.windowId }
}

async function runningElsewhere(
  entry: OngoingEntry
): Promise<{ sessionId: string; myWindowId: number } | null> {
  const { ids, myWindowId } = await tabsElsewhere([entry])
  return ids.has(entry.sessionId) && myWindowId !== null
    ? { sessionId: entry.sessionId, myWindowId }
    : null
}

/** The ids of the given entries whose tab runs in another window. */
export async function entriesElsewhere(entries: readonly OngoingEntry[]): Promise<Set<string>> {
  const { ids } = await tabsElsewhere(entries)
  return new Set(entries.filter((e) => ids.has(e.sessionId)).map((e) => e.id))
}

/** The reason an open was refused, worded for the page. */
export class OngoingOpenRefused extends Error {}

async function waitForSession(id: string, ms = 4000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (useSessionStore.getState().sessions.some((s) => s.id === id)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

/** Open an ongoing conversation in the pane: its tab when it runs here; its
 *  tab brought over when it runs in another window; else the conversation
 *  resumed in a new tab that stays ongoing. Never a second agent on it. */
export async function openOngoing(entryId: string): Promise<string | null> {
  return exclusive(entryId, async () => {
    const entry = useOngoingStore.getState().entries.find((e) => e.id === entryId)
    if (!entry) return null
    const session = sessionOfEntry<Session>(entry, useSessionStore.getState().sessions)
    let id: string | null = session && session.alive ? session.id : null
    if (!id) {
      const other = await runningElsewhere(entry)
      if (other) {
        const moved = await window.electronAPI.windowMoveSessions(
          [other.sessionId],
          other.myWindowId
        )
        if (!moved.moved.includes(other.sessionId) || !(await waitForSession(other.sessionId)))
          throw new OngoingOpenRefused(
            'This conversation is open in another window, and its tab cannot be brought over.'
          )
        id = other.sessionId
      }
    }
    if (!id) id = await resumeEntry(entry, true)
    if (!id) return null
    useSessionStore.getState().selectSession(id, false)
    useSessionStore.getState().setFocusedSession(id)
    return id
  })
}

/** Put the conversation back in the sidebar, where its tab sat; a resting
 *  one is resumed first, into the group it came from when that still runs.
 *  One running in another window goes back to that window's sidebar. */
export async function returnToSidebar(entryId: string): Promise<void> {
  await exclusive(
    entryId,
    async () => {
      const entry = useOngoingStore.getState().entries.find((e) => e.id === entryId)
      if (!entry) return
      const session = sessionOfEntry<Session>(entry, useSessionStore.getState().sessions)
      let id: string | null = session && session.alive ? session.id : null
      if (!id && !(await runningElsewhere(entry))) id = await resumeEntry(entry, false)
      await useOngoingStore.getState().update((entries) => entries.filter((e) => e.id !== entryId))
      if (id) {
        useSessionStore.getState().selectSession(id, false)
        useSessionStore.getState().setFocusedSession(id)
      }
    },
    true
  )
}

/** End the conversation: its tab is closed and it leaves Ongoing. The
 *  conversation itself stays in the session history. */
export async function endOngoing(entryId: string): Promise<void> {
  await exclusive(
    entryId,
    async () => {
      const entry = useOngoingStore.getState().entries.find((e) => e.id === entryId)
      if (!entry) return
      let session = sessionOfEntry<Session>(entry, useSessionStore.getState().sessions)
      if (!session) {
        // Its tab runs in another window: brought here first, so it is closed
        // here and leaves nothing behind there; a tab that cannot move is
        // stopped where it is.
        const other = await runningElsewhere(entry)
        if (other) {
          // A move takes focus in its new window; the person stays where they
          // were (the page, the tabs they had), since this tab only comes to go.
          const view = keepPersonsView(other.sessionId)
          const moved = await window.electronAPI
            .windowMoveSessions([other.sessionId], other.myWindowId)
            .catch(() => null)
          if (moved?.moved.includes(other.sessionId) && (await waitForSession(other.sessionId))) {
            session = useSessionStore.getState().sessions.find((s) => s.id === other.sessionId)
            view.restore()
          } else {
            view.restore()
            await window.electronAPI.killSession(other.sessionId).catch(() => {})
            // The window that holds it drops its row (R3-N1).
            announceEnded(other.sessionId)
          }
        }
      }
      await useOngoingStore.getState().update((entries) => entries.filter((e) => e.id !== entryId))
      if (!session) return
      const state = useSessionStore.getState()
      emitTabClosed(session, state.groups, 'user', null)
      try {
        await window.electronAPI.killSession(session.id)
      } catch {
        if (isRemoteKey(session.id)) return
        // already gone
      }
      useSessionStore.getState().removeSession(session.id)
    },
    true
  )
}

type PersonsView = Pick<
  ReturnType<typeof useSessionStore.getState>,
  'activeView' | 'selectedSessionIds' | 'focusedSessionId'
>
function viewOf(state: PersonsView): PersonsView {
  return {
    activeView: state.activeView,
    selectedSessionIds: state.selectedSessionIds,
    focusedSessionId: state.focusedSessionId
  }
}

/** What the person looks at, kept across a move that brings `movedId` here
 *  only to end it. The move's own focus on that tab is undone; a change the
 *  person made meanwhile (another tab picked, another view) is theirs and
 *  stays (R3-N2). `restore` is called once, when the move is over. */
export function keepPersonsView(movedId: string): { restore: () => void } {
  const isMove = (st: PersonsView): boolean =>
    st.focusedSessionId === movedId || st.selectedSessionIds.includes(movedId)
  let latest = viewOf(useSessionStore.getState())
  const stop = useSessionStore.subscribe((st, prev) => {
    if (isMove(st)) return
    if (
      st.activeView !== prev.activeView ||
      st.selectedSessionIds !== prev.selectedSessionIds ||
      st.focusedSessionId !== prev.focusedSessionId
    )
      latest = viewOf(st)
  })
  return {
    restore: () => {
      stop()
      if (isMove(useSessionStore.getState())) useSessionStore.setState(latest)
    }
  }
}

/** Another window ended a tab this window holds, after its move here was
 *  refused: it was stopped already, so its row goes (R3-N1). */
export function dropEndedTab(sessionId: string): void {
  const state = useSessionStore.getState()
  const session = state.sessions.find((s) => s.id === sessionId)
  if (!session) return
  emitTabClosed(session, state.groups, 'user', null)
  useSessionStore.getState().removeSession(sessionId)
}

export function setOngoingNote(entryId: string, note: string): void {
  const clean = note.replace(/\s+/g, ' ').trim().slice(0, 240)
  void useOngoingStore
    .getState()
    .update((entries) => entries.map((e) => (e.id === entryId ? { ...e, note: clean } : e)))
}

/**
 * Keep each entry true to the tab it lives in: its name follows a rename,
 * and its conversation id follows the provider's (a Claude tab learns its id
 * at the first message, a resume may hand out a new one). Writes only on a
 * real change.
 */
export function startOngoingFollow(): () => void {
  return useSessionStore.subscribe((state, prev) => {
    if (state.sessions === prev.sessions) return
    const { entries } = useOngoingStore.getState()
    const changes = new Map<string, Partial<OngoingEntry>>()
    for (const e of entries) {
      const s = state.sessions.find((x) => x.id === e.sessionId)
      if (!s) continue
      const conv = resumableConversation(s)
      const patch: Partial<OngoingEntry> = {}
      if (s.name && s.name !== e.name) patch.name = s.name
      if (conv && conv.conversationId !== e.conversationId)
        patch.conversationId = conv.conversationId
      if (s.cwd && s.cwd !== e.cwd) patch.cwd = s.cwd
      // An account switch or a model change restarts the tab on new launch
      // fields: the resume after a reboot must run on them.
      const launch = launchOf(s)
      if (!sameLaunch(launch, e.launch)) patch.launch = launch
      if (Object.keys(patch).length > 0) changes.set(e.id, patch)
    }
    if (changes.size === 0) return
    void useOngoingStore
      .getState()
      .update((list) => list.map((e) => (changes.has(e.id) ? { ...e, ...changes.get(e.id) } : e)))
  })
}

/** The boot's word on the resting conversations: what their dropped records
 *  knew of the launch (the account, the model) stays with the entries. */
export function keepRestingLaunch(next: readonly OngoingEntry[]): void {
  const { entries } = useOngoingStore.getState()
  const changed = next.filter((n) => {
    const e = entries.find((x) => x.id === n.id)
    return e && (e.cwd !== n.cwd || !sameLaunch(e.launch, n.launch))
  })
  if (changed.length === 0) return
  void useOngoingStore.getState().update((list) =>
    list.map((e) => {
      const n = changed.find((x) => x.id === e.id)
      return n ? { ...e, cwd: n.cwd, launch: n.launch } : e
    })
  )
}
