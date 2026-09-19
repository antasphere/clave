import type { SessionRecord } from '../../../preload/index.d'
import { useSessionStore } from '../store/session-store'
import type { Session, SessionViewConfig } from '../store/session-types'
import { resolveHiddenOwner } from './boot-adoption'
import { legacyAgentProvider } from '../../../shared/session-migration'
import { remapHiddenOwner, remapSessionId } from '../../../shared/session-remap'
import { applySessionMappings } from './session-migration'

/**
 * Bring one persisted session record back as a live tab in THIS window's
 * store (PRDCT-1703). Shared by two callers:
 *  - boot restore (AppShell): this window's survivors of a previous run;
 *  - re-homing: a session detached from another window that this window
 *    now holds — a closing window's sessions handed to the primary, or a tab
 *    (or a whole group) moved here.
 *
 * Placement is neutral (adoptSessionInPlace): an adopted tab joins the group
 * that already holds it (the restored or handed-over layout) or the top
 * level, never the target window's selected group, and never both.
 * Live tmux survivors reattach to the running process (scrollback intact via
 * the tmux repaint); dead records relaunch fresh in the same cwd (Claude
 * resuming via claudeSessionId). The original session id is preserved
 * (`adoptSessionId`) so MCP addressing, lifecycle-hook status and exchange
 * capture keep working across the move exactly as across an app restart.
 * Returns the new session id, or null on failure.
 */
export async function adoptRecord(
  s: SessionRecord,
  activeWorkspaceId: string | null,
  options: { focus?: boolean } = {}
): Promise<string | null> {
  const spawned = await spawnFromRecord(s, activeWorkspaceId)
  if (!spawned) return null
  useSessionStore.getState().adoptSessionInPlace(spawned.session, { focus: options.focus === true })
  return spawned.session.id
}

/**
 * Reattach a record's process and build the Session object for it, without
 * touching the store. The half every adoption shares: `adoptRecord` places it
 * as a tab, `adoptHiddenRecord` hangs it back off its owner.
 */
async function spawnFromRecord(
  s: SessionRecord,
  activeWorkspaceId: string | null
): Promise<{ session: Session } | null> {
  try {
    const workspaceId = s.workspaceId ?? activeWorkspaceId ?? undefined
    const legacyAgentId = legacyAgentProvider(s) ? s.id : undefined
    const info = legacyAgentId
      ? {
          ...s,
          alive: Boolean(s.live),
          claudeSessionId: s.claudeSessionId ?? null
        }
      : await window.electronAPI.spawnSession(s.cwd, {
          claudeMode: s.claudeMode,
          antigravityMode: s.antigravityMode,
          codexMode: s.codexMode,
          piMode: s.piMode,
          claudeAgentsMode: s.claudeAgentsMode,
          dangerousMode: s.dangerousMode,
          model: s.model,
          // Live survivor: MUST go through tmux to reattach. Dead record: fresh
          // spawn under the current global tmux preference — the name is still
          // offered so a tmux respawn reuses it.
          ...(s.live && s.tmuxName
            ? { tmuxMode: true, adoptTmuxName: s.tmuxName }
            : s.tmuxName
              ? { adoptTmuxName: s.tmuxName }
              : {}),
          // Reuse the original id so lifecycle-hook status routing keeps working.
          adoptSessionId: s.id,
          // Live survivor: reattach (claudeSessionId only drives the badge). Dead
          // record: re-spawn with --resume to reload the prior conversation.
          ...(s.live
            ? { claudeSessionId: s.claudeSessionId, piSessionId: s.piSessionId }
            : s.claudeMode && s.claudeSessionId
              ? { resumeSessionId: s.claudeSessionId }
              : s.piMode && s.piSessionId
                ? { resumeSessionId: s.piSessionId }
                : {}),
          launchProfileId: s.launchProfileId,
          piProvider: s.piProvider,
          piThinking: s.piThinking,
          configDir: s.configDir,
          claudeProfileId: s.claudeProfileId,
          claudeProfileLabel: s.claudeProfileLabel,
          workspaceId,
          // Carry the ownership forward: an adoption rewrites the record, and a
          // hidden half that came back unstamped would be a tab at the NEXT boot.
          link: s.link
        })
    const session: Session = {
      id: info.id,
      legacyAgentId,
      cwd: info.cwd,
      folderName: info.folderName,
      name: s.displayName || s.folderName,
      userRenamed: s.userRenamed === true,
      alive: info.alive,
      activityStatus: 'idle',
      promptWaiting: null,
      claudeMode: s.claudeMode,
      antigravityMode: s.antigravityMode,
      codexMode: s.codexMode,
      piMode: s.piMode,
      claudeAgentsMode: s.claudeAgentsMode,
      dangerousMode: s.dangerousMode,
      model: info.model,
      claudeSessionId: info.claudeSessionId,
      piSessionId: info.piSessionId,
      launchProfileId: info.launchProfileId,
      piProvider: info.piProvider,
      piThinking: info.piThinking,
      claudeProfileId: s.claudeProfileId,
      claudeProfileLabel: s.claudeProfileLabel,
      claudeConfigDir: s.configDir,
      sessionType: 'local',
      workspaceId,
      view: s.view ? { ...s.view } : undefined,
      // The defaults normalizeSession would fill in anyway, spelled out so
      // this is a whole Session both adoption paths can hand around.
      detectedUrl: null,
      serverStatus: null,
      serverCommand: null,
      hasUnseenActivity: false,
      planFilePath: null
    }
    return { session }
  } catch (err) {
    console.error('Failed to adopt session record:', s.tmuxName ?? s.id, err)
    return null
  }
}

/**
 * Bring back a session that is the HIDDEN HALF of something else — a group's
 * quick-launch terminal, a session view's serving process (PRDCT-1756). It
 * joins the store without ever entering the top-level order, and is linked
 * straight back to its owner from the record's own `link`, which is the only
 * copy of that relationship that survives a quit.
 *
 * The owner can legitimately be gone (the group was deleted, the owning tab
 * did not come back). Then the record is DISCARDED — its process stopped and
 * its file removed — never surfaced as a tab (PRDCT-2038, reversing the
 * PRDCT-1756 choice): a deletion now stops the group's terminals itself, so
 * an orphan here is a group that no longer exists, and the record holds
 * nothing that would let the group be rebuilt around it. The rule is
 * `resolveHiddenOwner`, pure and pinned by its tests.
 *
 * Returns the adopted session id, or null when nothing was adopted.
 */
export async function adoptHiddenRecord(
  s: SessionRecord,
  activeWorkspaceId: string | null
): Promise<string | null> {
  const link = s.link
  if (!link || link.kind === 'toolbar') return null
  const state = useSessionStore.getState()
  // The owner has to be there BEFORE the process is reattached: a spawn is
  // slow, and a group deleted meanwhile would leave us linking into nothing.
  const ownerView: SessionViewConfig | null =
    link.kind === 'session-view'
      ? (state.sessions.find((o) => o.id === link.ownerId)?.view ?? null)
      : null
  if (resolveHiddenOwner(link, state) === 'discard') {
    console.warn('[boot] discarding hidden session record with no owner:', s.tmuxName ?? s.id, link)
    void window.electronAPI?.discardSessionRecord?.(s.tmuxName ?? s.id)
    return null
  }

  const spawned = await spawnFromRecord(s, activeWorkspaceId)
  if (!spawned) return null
  const store = useSessionStore.getState()
  store.addHiddenSession(spawned.session)
  // Hidden panes are never measured, so the pty would sit unspawned and the
  // tmux client would never reattach: kick it exactly as the spawn paths do.
  window.electronAPI.startSession(spawned.session.id, 120, 30)
  if (link.kind === 'group-terminal') {
    store.setGroupTerminalSessionId(link.groupId, link.terminalId, spawned.session.id)
  } else if (ownerView) {
    store.setSessionView(link.ownerId, { ...ownerView, serverSessionId: spawned.session.id })
  }
  return spawned.session.id
}

/**
 * Adopt records for the given session ids — the re-home path. Fetches those
 * records whatever window they were stamped with (main just detached them
 * from their old window; they are adoptable-live), adopts each into this
 * window (the adoption re-stamps the record to this window), skipping any
 * already in this store, then acknowledges to main so a caller waiting to
 * act on the moved tab here (an MCP move into a group) can proceed.
 */
const pendingRehomes = new Map<
  string,
  { ids: string[]; workspaceId: string | null; focus: boolean }
>()

/** A service outage must not strand a tab already detached by the source window. */
export async function retryPendingRehomes(): Promise<void> {
  for (const request of [...pendingRehomes.values()]) {
    await adoptRehomed(request.ids, request.workspaceId, request.focus)
  }
}

export async function adoptRehomed(
  ids: string[],
  activeWorkspaceId: string | null,
  focus = false
): Promise<void> {
  if (ids.length === 0) return
  const key = JSON.stringify(ids)
  pendingRehomes.set(key, { ids, workspaceId: activeWorkspaceId, focus })
  const mappings = await window.electronAPI.sessionMigration.mappings().catch(() => ({}))
  applySessionMappings(mappings)
  const mappedIds = [...new Set(ids.map((id) => remapSessionId(id, mappings)))]
  const already = new Set(useSessionStore.getState().sessions.map((s) => s.id))
  const conversationIds = mappedIds.filter((id) => id.startsWith('conversation-'))
  let complete = true
  if (conversationIds.length) {
    const { conversationToSession } = await import('./conversation-sessions')
    for (const id of conversationIds) {
      if (already.has(id)) continue
      try {
        const { session } = await window.electronAPI.conversations.snapshot(id)
        useSessionStore.getState().adoptSessionInPlace(conversationToSession(session), { focus })
        focus = false
      } catch {
        complete = false
      }
    }
  }
  const terminalIdsToAdopt = mappedIds.filter((id) => !id.startsWith('conversation-'))
  const records = terminalIdsToAdopt.length
    ? ((await window.electronAPI
        ?.listSessionRecords?.({ ids: terminalIdsToAdopt })
        .catch(() => [])) ?? [])
    : []
  if (terminalIdsToAdopt.some((id) => !already.has(id) && !records.some((r) => r.id === id))) {
    complete = false
  }
  // A deliberate move focuses ONE tab that lands: a group member or a
  // single moved tab, never a quick-launch terminal riding along (the
  // records come back in directory order, which would otherwise put the
  // user on a `sleep 900` pane as often as on the agent). The rest arrive
  // quietly beside it.
  const terminalIds = new Set<string>()
  for (const g of useSessionStore.getState().groups) {
    for (const t of g.terminals) if (t.sessionId) terminalIds.add(t.sessionId)
  }
  const ordered = records
    .map((record) => remapHiddenOwner(record, mappings))
    .sort((a, b) => Number(terminalIds.has(a.id)) - Number(terminalIds.has(b.id)))
  let first = true
  for (const r of ordered) {
    if (already.has(r.id)) continue
    const link = r.link
    if (
      link?.kind === 'session-view' &&
      !useSessionStore.getState().sessions.some((session) => session.id === link.ownerId)
    ) {
      complete = false
      continue
    }
    const takeFocus = focus && first && !terminalIds.has(r.id)
    const id =
      r.link?.kind === 'session-view' || r.link?.kind === 'group-terminal'
        ? await adoptHiddenRecord(r, activeWorkspaceId)
        : await adoptRecord(r, activeWorkspaceId, { focus: takeFocus })
    if (id && takeFocus) first = false
    if (!id) complete = false
  }
  if (complete) {
    pendingRehomes.delete(key)
    window.electronAPI?.ackRehomed?.(ids)
  }
}
