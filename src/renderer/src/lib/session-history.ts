import { isRemoteKey, ownerOf } from './fleet-identity'
import { useSessionStore, inActiveWorkspace } from '../store/session-store'
import { getActiveWorkspaceId } from '../store/workspace-store'
import { SessionHistoryDiff, historyResumeLaunch, resumeTargetGroup } from './session-history-diff'
import { useClaudeProfileStore } from '../store/claude-profile-store'
import { useCodexAccountStore } from '../store/codex-account-store'
import type { HistoryListEntry, HistoryLedgerRow } from '../../../preload/index.d'
import { useFleetStore } from '../store/fleet-store'
import { CLAVE_PROVIDER_PREFIX } from '../../../shared/provider-prefix'

/**
 * The store glue of the session history (PRDCT-1738): the ledger's writer
 * (a diff over the store, see session-history-diff.ts) and the resume action
 * the dialog's rows perform. Fire-and-forget on the write side, like the
 * exchange capture: a ledger failure never reaches a store update.
 */

let diff: SessionHistoryDiff | null = null
let unsubscribe: (() => void) | null = null

function send(row: HistoryLedgerRow): void {
  if (isRemoteKey(row.sessionId)) return
  try {
    window.electronAPI?.historyStamp?.(row)
  } catch {
    // observability, never a reason to break the store
  }
}

/** Start the diff. Called once the boot adoption has rebuilt the groups, so
 *  the first pass stamps the restored tabs where they actually sit rather
 *  than mid-restore. Idempotent. */
export function startSessionHistoryStamping(): void {
  if (unsubscribe) return
  diff = new SessionHistoryDiff(send)
  diff.apply(useSessionStore.getState())
  unsubscribe = useSessionStore.subscribe((state, prev) => {
    if (
      state.sessions === prev.sessions &&
      state.groups === prev.groups &&
      state.displayOrder === prev.displayOrder
    )
      return
    diff?.apply(state)
  })
}

/** An account's current label when it still exists on this Mac, else null. */
function knownAccountLabel(provider: 'claude' | 'codex', id: string): string | null {
  const list =
    provider === 'claude'
      ? useClaudeProfileStore.getState().profiles
      : useCodexAccountStore.getState().accounts
  return list.find((a) => a.id === id)?.label ?? null
}

/**
 * Resume a history entry: focus the live tab when the conversation is still
 * open, else spawn `claude --resume <id>` in the entry's own cwd (the
 * transcript lives under that cwd's project dir) and place the tab in ONE
 * step (`addSessionInGroup`) where `resumeTargetGroup` says. Same spawn the
 * sidebar's own Resume uses; returns the tab id, or null when nothing could
 * be opened.
 */
export async function resumeHistoryEntry(
  entry: HistoryListEntry,
  options: {
    groupId: string | null
    dangerousMode: boolean
    /** The launch profile to resume on, when not the global one: a chat tab's
     *  /resume opens the conversation as a chat, whatever the default is. */
    launchProfileId?: string
  }
): Promise<string | null> {
  const state = useSessionStore.getState()
  const live = state.sessions.find(
    (s) =>
      s.alive &&
      ownerOf(s.id) === ownerOf(entry.sessionId) &&
      (s.claudeSessionId === entry.claudeSessionId || s.piSessionId === entry.claudeSessionId)
  )
  if (live) {
    state.selectSession(live.id, false)
    state.setFocusedSession(live.id)
    return live.id
  }
  if (entry.server) return resumeOnServer(entry, entry.server, options)
  if (!entry.transcript.exists) return null
  // A transcript that names no working directory anywhere cannot be resumed:
  // `claude --resume` only finds a conversation from its own project dir.
  if (!entry.cwd) return null
  const workspaceId = entry.workspaceId ?? getActiveWorkspaceId() ?? undefined
  try {
    const owner = ownerOf(entry.sessionId)
    const start =
      owner === 'local'
        ? window.electronAPI.spawnSession
        : (cwd: string, options: Parameters<typeof window.electronAPI.spawnSession>[1]) =>
            window.electronAPI.fleetStart(owner, cwd, options)
    // What it was launched on (PRDCT-4236): bypass, mode, effort, account.
    const launch = historyResumeLaunch(entry, options.dangerousMode, knownAccountLabel)
    // A `clave-*` provider lives only in its connection's directory, and History records no connection (PRDCT-4534): reopen on Pi's own default, its model with it.
    const clavePiProvider =
      entry.provider === 'pi' && !!entry.agentProvider?.startsWith(CLAVE_PROVIDER_PREFIX)
    const info = await start(entry.cwd, {
      claudeMode: entry.provider === 'claude',
      piMode: entry.provider === 'pi',
      ...launch,
      model: clavePiProvider ? undefined : (entry.model ?? undefined),
      piProvider:
        entry.provider === 'pi' && !clavePiProvider
          ? (entry.agentProvider ?? undefined)
          : undefined,
      piThinking: entry.provider === 'pi' ? (entry.thinking ?? undefined) : undefined,
      resumeSessionId: entry.claudeSessionId,
      ...(options.launchProfileId ? { launchProfileId: options.launchProfileId } : {}),
      workspaceId
    })
    const after = useSessionStore.getState()
    const shown = after.groups.filter((g) => inActiveWorkspace(g, getActiveWorkspaceId()))
    const target = resumeTargetGroup(entry.groups, options.groupId, shown)
    after.addSessionInGroup(
      {
        id: info.id,
        cwd: info.cwd,
        folderName: info.folderName,
        name: entry.title,
        alive: info.alive,
        activityStatus: 'idle',
        promptWaiting: null,
        claudeMode: entry.provider === 'claude',
        antigravityMode: false,
        codexMode: false,
        piMode: entry.provider === 'pi',
        dangerousMode: launch.dangerousMode,
        model: info.model,
        claudeProfileId: launch.claudeProfileId,
        claudeProfileLabel: launch.claudeProfileLabel,
        workspaceId,
        claudeSessionId: info.claudeSessionId,
        piSessionId: info.piSessionId,
        launchProfileId: info.launchProfileId,
        piProvider: info.piProvider,
        piThinking: info.piThinking,
        sessionType: 'local'
      },
      target
    )
    // Select through the store's own path too: it clears an active group or
    // session VIEW (a project's board covering the pane), which the one-step
    // add deliberately does not touch — without this the conversation is
    // spawned, placed and selected under the board, and the click looks
    // like nothing happened.
    useSessionStore.getState().selectSession(info.id, false)
    return info.id
  } catch (err) {
    console.error('Failed to resume session from history:', err)
    return null
  }
}

/** Whether a History row can be reopened from here (PRDCT-4321): a live tab
 *  is always focused; a server's conversation reopens only while its server
 *  is connected; this Mac's own needs its transcript and its folder. */
export function canResumeHistoryEntry(
  entry: HistoryListEntry,
  live: boolean,
  serverConnected: (serverId: string) => boolean
): boolean {
  if (live) return true
  if (entry.provider !== 'claude' && entry.provider !== 'pi') return false
  if (entry.server) {
    if (!serverConnected(entry.server.id)) return false
    // A tab of the server still holds it: that tab comes back, whatever the
    // transcript's state.
    if (entry.server.held === 'running' || entry.server.held === 'stopped') return true
    // The server's answer does not list it (a server older than its History,
    // a tab it ran before it kept one): its transcript is on the server's
    // disk, unknown here, so its folder is all this Mac can check.
    if (entry.server.held === null) return !!entry.cwd
  }
  return entry.transcript.exists && !!entry.cwd
}

/** A server's conversation, reopened on that server (PRDCT-4321): the tab
 *  that still holds it resumed in place, else a new tab of that server on
 *  the conversation, in its folder, in the server's own workspace and group;
 *  never on this Mac, never in one of this Mac's workspaces. A conversation
 *  the server does not list is started as a closed one is. */
async function resumeOnServer(
  entry: HistoryListEntry,
  server: NonNullable<HistoryListEntry['server']>,
  options: { groupId: string | null; dangerousMode: boolean }
): Promise<string | null> {
  const serverId = server.id
  if (useFleetStore.getState().statuses[serverId]?.state !== 'connected') return null
  const show = (id: string): string => {
    useSessionStore.getState().selectSession(id, false)
    useSessionStore.getState().setFocusedSession(id)
    return id
  }
  const restartInPlace = async (id: string): Promise<string> => {
    const result = await window.electronAPI.restartSession(id, { onlyIfStopped: true })
    if ('error' in result) throw new Error(result.error)
    await window.electronAPI.fleetSnapshot(serverId).catch(() => undefined)
    return show(id)
  }
  try {
    if (server.held === 'stopped') return await restartInPlace(entry.sessionId)
    if (server.held === 'running') {
      await window.electronAPI.fleetSnapshot(serverId).catch(() => undefined)
      return show(entry.sessionId)
    }
    // A stopped tab of this server may still hold the conversation where the
    // server's answer does not say so (an older server lists nothing): that
    // tab comes back in place, never a second tab on its conversation. A live
    // one was focused before this.
    const holder = useSessionStore
      .getState()
      .sessions.find(
        (s) => ownerOf(s.id) === serverId && s.claudeSessionId === entry.claudeSessionId
      )
    if (holder && !holder.alive) return await restartInPlace(holder.id)
    // A conversation the server does not list (held null) is started like a
    // closed one, its transcript unchecked: the server resumes it when its
    // transcript is there, as a start on a server always did.
    if (!entry.cwd) return null
    if (server.held === 'closed' && !entry.transcript.exists) return null
    // The account the server ran it on is the server's own: named by the
    // server's id and label, never looked up among this Mac's accounts.
    const launch = historyResumeLaunch(entry, options.dangerousMode, (_provider, id) =>
      entry.launch?.accountId === id ? (entry.launch.accountLabel ?? id) : null
    )
    const workspaceId =
      entry.workspaceId && ownerOf(entry.workspaceId) === serverId ? entry.workspaceId : undefined
    const info = await window.electronAPI.fleetStart(serverId, entry.cwd, {
      claudeMode: true,
      ...launch,
      model: entry.model ?? undefined,
      resumeSessionId: entry.claudeSessionId,
      // The way it ran there: its chat view, the server's own profile.
      ...(entry.launchProfileId ? { launchProfileId: entry.launchProfileId } : {}),
      ...(workspaceId ? { workspaceId } : {})
    })
    await window.electronAPI.fleetSnapshot(serverId).catch(() => undefined)
    const store = useSessionStore.getState()
    const group =
      options.groupId && ownerOf(options.groupId) === serverId
        ? options.groupId
        : entry.groups.find((g) => store.groups.some((shown) => shown.id === g.id))?.id
    if (group) store.moveItems([info.id], group, 'inside')
    return show(info.id)
  } catch (err) {
    console.error('Failed to resume a server conversation from history:', err)
    return null
  }
}
