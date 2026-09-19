import { flushLinkedDocument } from '../store/linked-document-store'
import type { LinkedOpen } from '../../../shared/linked-documents'
import {
  captureEndpoint as captureEndpointOf,
  emitTabClosed,
  groupOfSession,
  sessionMode,
  type SessionMode
} from './exchange-capture'
import { useSessionStore, fileTabDedupKey, inActiveWorkspace } from '../store/session-store'
import type {
  GroupTerminalConfig,
  GroupViewConfig,
  Session,
  SessionGroup
} from '../store/session-store'
import { usePinnedStore, getPinnedState, togglePinnedGroup } from '../store/pinned-store'
import type { PinnedGroupSession } from '../store/session-types'
import { useWorkspaceStore, type Workspace } from '../store/workspace-store'
import { profilesFor } from '../store/launch-profile-store'
import {
  useClaudeProfileStore,
  getClaudeProfile,
  resolveClaudeProfile,
  claudeProfileSpawnFields,
  sessionAccount,
  type ClaudeProfile
} from '../store/claude-profile-store'
import type { PiThinkingLevel } from '../../../shared/agent-launch'
import { setActiveWorkspace } from './workspace-actions'
import { getRegisteredTerminal } from './terminal-registry'
import { getDraftShadow, type DraftStash } from './draft-shadow'
import { conversationComposer } from './conversation-composer'
import {
  buildCheckpointProvenance,
  buildProvenanceHeader
} from '../../../shared/exchange-provenance'

/**
 * Renderer-side executor for the in-app MCP server. The sidebar state (groups,
 * tabs) lives in this process's Zustand store, so the main process forwards
 * each MCP tool call here over `mcp:command` and we reply on `mcp:response`.
 */

interface McpCommandMessage {
  requestId: string
  command: string
  payload: unknown
}

/** Resolve a workspace reference: id, exact name, or case-insensitive name. */
function resolveWorkspace(ref: string): Workspace {
  const { workspaces } = useWorkspaceStore.getState()
  if (workspaces.length === 0) {
    throw new Error('No workspaces configured — the workspace parameter cannot be used')
  }
  const ws =
    workspaces.find((w) => w.id === ref) ??
    workspaces.find((w) => w.name === ref) ??
    workspaces.find((w) => w.name.toLowerCase() === ref.toLowerCase())
  if (!ws) {
    throw new Error(`No workspace "${ref}". Available: ${workspaces.map((w) => w.name).join(', ')}`)
  }
  return ws
}

function workspaceNameOf(id: string | null | undefined): string | null {
  if (!id) return null
  return useWorkspaceStore.getState().workspaces.find((w) => w.id === id)?.name ?? null
}

/** Workspace to stamp on something an agent creates: an explicit `workspace`
 *  param wins, else the CALLER tab's workspace (agents stay in their own
 *  workspace by default), else the active one. Undefined in no-workspace mode. */
function workspaceForSpawn(
  explicit: string | undefined,
  callerSessionId: string | undefined
): string | undefined {
  if (explicit) return resolveWorkspace(explicit).id
  const caller = callerSessionId
    ? useSessionStore.getState().sessions.find((s) => s.id === callerSessionId)
    : undefined
  return caller?.workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId ?? undefined
}

/** Resolve a tool's group reference: a group id, a group name, or "mine".
 *  Name resolution is workspace-scoped — caller's workspace first, then the
 *  active one, then a unique global match; a name that matches in several
 *  workspaces errors with qualified candidates instead of picking one. */
function resolveGroup(
  groups: SessionGroup[],
  ref: string,
  callerSessionId: string | undefined
): SessionGroup {
  if (ref === 'mine') {
    if (!callerSessionId) {
      throw new Error('groupId "mine" requires the call to come from inside a Clave session')
    }
    const group = groupOfSession(groups, callerSessionId)
    if (!group) throw new Error('The calling session is not in any group')
    return group
  }
  const byId = groups.find((g) => g.id === ref)
  if (byId) return byId

  const named = groups.filter((g) => g.name === ref)
  if (named.length === 0) throw new Error(`No group with id or name "${ref}"`)
  if (named.length === 1) return named[0]

  const callerWs = callerSessionId
    ? useSessionStore.getState().sessions.find((s) => s.id === callerSessionId)?.workspaceId
    : undefined
  const inCallerWs = callerWs ? named.filter((g) => g.workspaceId === callerWs) : []
  if (inCallerWs.length === 1) return inCallerWs[0]
  const activeWs = useWorkspaceStore.getState().activeWorkspaceId
  const inActiveWs = activeWs ? named.filter((g) => g.workspaceId === activeWs) : []
  if (inActiveWs.length === 1) return inActiveWs[0]

  const qualified = named
    .map((g) => `${workspaceNameOf(g.workspaceId) ?? '?'}/${g.name} (${g.id})`)
    .join(', ')
  throw new Error(
    `Group name "${ref}" is ambiguous across workspaces — use an id. Candidates: ${qualified}`
  )
}

function handleList(payload: { callerSessionId?: string; workspace?: string }): unknown {
  const state = useSessionStore.getState()
  const wsState = useWorkspaceStore.getState()

  // Optional scoping: 'all' (default — agents may orchestrate across
  // workspaces), 'active', or a workspace id/name.
  const scope = payload.workspace ?? 'all'
  const scopeId: string | null | 'all' =
    scope === 'all'
      ? 'all'
      : scope === 'active'
        ? wsState.activeWorkspaceId
        : resolveWorkspace(scope).id
  const inScope = (x: { workspaceId?: string | null }): boolean =>
    scopeId === 'all' || inActiveWorkspace(x, scopeId)

  const sessions = state.sessions
    .filter((s) => s.sessionType === 'local' && inScope(s))
    .map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      mode: sessionMode(s),
      alive: s.alive,
      agentState: s.agentState ?? null,
      // The Claude account the tab runs on; the Default when the tab predates
      // accounts or was launched without naming one.
      account: s.claudeMode || s.claudeAgentsMode ? sessionAccount(s) : null,
      groupId: groupOfSession(state.groups, s.id)?.id ?? null,
      view: s.view ? { url: s.view.url, title: s.view.title ?? null } : null,
      workspaceId: s.workspaceId ?? null,
      workspaceName: workspaceNameOf(s.workspaceId)
    }))
  const groups = state.groups.filter(inScope).map((g) => ({
    id: g.id,
    name: g.name,
    cwd: g.cwd,
    color: g.color ?? null,
    view: g.view ?? null,
    sessionIds: g.sessionIds,
    workspaceId: g.workspaceId ?? null,
    workspaceName: workspaceNameOf(g.workspaceId),
    terminals: g.terminals.map((t) => ({
      id: t.id,
      command: t.command,
      commandMode: t.commandMode,
      color: t.color,
      icon: t.icon ?? null,
      serverUrl: t.serverUrl ?? null,
      sessionId: t.sessionId
    }))
  }))
  const pinnedSessionMode = (s: PinnedGroupSession): SessionMode => {
    if (s.antigravityMode) return 'antigravity'
    if (s.codexMode) return 'codex'
    if (s.piMode) return 'pi'
    if (s.claudeAgentsMode) return 'claude-agents'
    if (s.claudeMode) return 'claude'
    return 'terminal'
  }
  // Pinned groups = launchable templates from .clave files (auto-discovered or
  // imported). clave_launch_group spawns them by id or name.
  const pinnedGroups = usePinnedStore
    .getState()
    .pinnedGroups.filter(inScope)
    .map((pg) => ({
      id: pg.id,
      name: pg.name,
      cwd: pg.cwd,
      category: pg.category ?? null,
      sourceFile: pg.filePath ?? pg.discoveredBy ?? null,
      state: getPinnedState(pg),
      activeGroupId: pg.activeGroupId,
      workspaceId: pg.workspaceId ?? null,
      workspaceName: workspaceNameOf(pg.workspaceId),
      sessions: pg.sessions.map((s) => ({ name: s.name, cwd: s.cwd, mode: pinnedSessionMode(s) })),
      terminals: pg.terminals.map((t) => ({ command: t.command, commandMode: t.commandMode }))
    }))
  const callerSessionId = payload.callerSessionId ?? null
  return {
    workspaces: wsState.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      rootDir: w.rootDir,
      active: w.id === wsState.activeWorkspaceId
    })),
    activeWorkspaceId: wsState.activeWorkspaceId,
    groups,
    sessions,
    pinnedGroups,
    focusedSessionId: state.focusedSessionId,
    callerSessionId,
    callerGroupId: callerSessionId
      ? (groupOfSession(state.groups, callerSessionId)?.id ?? null)
      : null
  }
}

async function handleLaunchGroup(payload: {
  group: string
  workspace?: string
  callerSessionId?: string
}): Promise<unknown> {
  const pinnedGroups = usePinnedStore.getState().pinnedGroups
  // Optional explicit workspace narrows the search; otherwise name resolution
  // prefers the caller's workspace, then the active one, then a unique global
  // match — "Syndicable" existing in two workspaces must not silently pick one.
  const pool = payload.workspace
    ? (() => {
        const ws = resolveWorkspace(payload.workspace)
        return pinnedGroups.filter((p) => p.workspaceId === ws.id)
      })()
    : pinnedGroups
  const byId = pool.find((p) => p.id === payload.group)
  const named = byId
    ? [byId]
    : (() => {
        const exact = pool.filter((p) => p.name === payload.group)
        if (exact.length > 0) return exact
        return pool.filter((p) => p.name.toLowerCase() === payload.group.toLowerCase())
      })()
  let pg = named.length === 1 ? named[0] : undefined
  if (!pg && named.length > 1) {
    const callerWs = payload.callerSessionId
      ? useSessionStore.getState().sessions.find((s) => s.id === payload.callerSessionId)
          ?.workspaceId
      : undefined
    const inCallerWs = callerWs ? named.filter((p) => p.workspaceId === callerWs) : []
    if (inCallerWs.length === 1) pg = inCallerWs[0]
    if (!pg) {
      const activeWs = useWorkspaceStore.getState().activeWorkspaceId
      const inActiveWs = activeWs ? named.filter((p) => p.workspaceId === activeWs) : []
      if (inActiveWs.length === 1) pg = inActiveWs[0]
    }
    if (!pg) {
      const qualified = named
        .map((p) => `${workspaceNameOf(p.workspaceId) ?? '?'}/${p.name} (${p.id})`)
        .join(', ')
      throw new Error(
        `Pinned group "${payload.group}" is ambiguous across workspaces — pass the workspace parameter or an id. Candidates: ${qualified}`
      )
    }
  }
  if (!pg) {
    const available = pool.map((p) => p.name).join(', ') || '(none)'
    throw new Error(`No pinned group "${payload.group}". Available: ${available}`)
  }

  // A pin can point at a group that was since deleted — e.g. an agent moved
  // the pin's last tab out, which prunes the now-empty group. The pin still
  // reads as active-visible (activeGroupId set, visible true), which would
  // make both the early-return below AND togglePinnedGroup's hide-path treat
  // it as live and never respawn. Reset the stale link so the toggle takes the
  // fresh-spawn path.
  const linkedGroupAlive = (g: string | null): boolean =>
    !!g && useSessionStore.getState().groups.some((grp) => grp.id === g)
  if (pg.activeGroupId && !linkedGroupAlive(pg.activeGroupId)) {
    usePinnedStore.getState().setActiveGroupId(pg.id, null)
    usePinnedStore.getState().setVisible(pg.id, false)
  }

  const current = usePinnedStore.getState().pinnedGroups.find((p) => p.id === pg.id) ?? pg
  const stateBefore = getPinnedState(current)
  if (stateBefore === 'active-visible') {
    return { pinnedId: pg.id, groupId: current.activeGroupId, status: 'already-running' }
  }
  // idle → spawn all sessions + terminals; active-hidden → show the live group.
  await togglePinnedGroup(pg.id)
  const after = usePinnedStore.getState().pinnedGroups.find((p) => p.id === pg.id)
  if (!after?.activeGroupId) {
    throw new Error(`Launching "${pg.name}" spawned no sessions — check that its directories exist`)
  }
  return {
    pinnedId: pg.id,
    groupId: after.activeGroupId,
    status: stateBefore === 'idle' ? 'launched' : 'shown'
  }
}

function handleCreateGroup(payload: {
  name: string
  prompt?: string
  workspace?: string
  callerSessionId?: string
}): unknown {
  const store = useSessionStore.getState()
  store.createGroup([], payload.name, workspaceForSpawn(payload.workspace, payload.callerSessionId))
  const created = useSessionStore.getState().groups.at(-1)
  if (!created) throw new Error('Group creation failed')
  if (payload.prompt) useSessionStore.getState().setGroupPrompt(created.id, payload.prompt)
  return {
    groupId: created.id,
    name: created.name,
    workspaceId: created.workspaceId ?? null,
    prompt: useSessionStore.getState().groups.find((g) => g.id === created.id)?.prompt ?? null
  }
}

/** A session moved into a group joins that group's workspace — a group must
 *  never hold members it can't show. No-op when they already agree. */
function alignSessionToGroupWorkspace(sessionId: string, group: SessionGroup): void {
  const state = useSessionStore.getState()
  const session = state.sessions.find((s) => s.id === sessionId)
  if (!session || (session.workspaceId ?? null) === (group.workspaceId ?? null)) return
  useSessionStore.setState({
    sessions: state.sessions.map((s) =>
      s.id === sessionId ? { ...s, workspaceId: group.workspaceId } : s
    )
  })
  if (session.sessionType === 'local') {
    void window.electronAPI?.setSessionWorkspace(sessionId, group.workspaceId ?? null)
  }
}

/** The Claude account an agent's spawn runs on: the one it named (an id or a
 *  label), else the one selected in settings. An unknown name errors with the
 *  names that exist, never a silent fall-through to the wrong subscription. */
export function resolveAccountForSpawn(ref: string | undefined): ClaudeProfile {
  const { profiles, selectedProfileId } = useClaudeProfileStore.getState()
  if (!ref) return getClaudeProfile(selectedProfileId)
  const account = resolveClaudeProfile(profiles, ref)
  if (!account) {
    const names = profiles.map((p) => `"${p.label}" (${p.id})`).join(', ')
    throw new Error(`Unknown Claude account "${ref}". Available: ${names}`)
  }
  return account
}

export async function openSessionProgrammatically(payload: {
  cwd: string
  mode?: 'claude' | 'antigravity' | 'gemini' | 'codex' | 'pi' | 'terminal'
  groupId?: string
  name?: string
  dangerous?: boolean
  model?: string
  profile?: string
  /** The Claude account (id or label) the tab runs on; claude mode only. */
  account?: string
  provider?: string
  thinking?: PiThinkingLevel
  command?: string
  autoRun?: boolean
  prompt?: string
  workspace?: string
  callerSessionId?: string
}): Promise<unknown> {
  const state = useSessionStore.getState()
  // Resolve the target group before spawning so a bad reference fails cleanly.
  const targetGroup = payload.groupId
    ? resolveGroup(state.groups, payload.groupId, payload.callerSessionId)
    : null

  // Workspace: explicit param > target group's > caller's > active. A session
  // placed into a group must land in that group's workspace either way.
  const workspaceId = payload.workspace
    ? resolveWorkspace(payload.workspace).id
    : (targetGroup?.workspaceId ?? workspaceForSpawn(undefined, payload.callerSessionId))

  const mode = payload.mode ?? 'claude'
  const claudeMode = mode === 'claude'
  // 'gemini' is accepted as a deprecated alias for the retired Gemini CLI.
  const antigravityMode = mode === 'antigravity' || mode === 'gemini'
  const codexMode = mode === 'codex'
  const piMode = mode === 'pi'
  // --dangerously-skip-permissions is a claude flag; other providers ignore it.
  const dangerousMode = claudeMode && payload.dangerous === true
  // model maps to claude --model / codex -m; antigravity and terminals have no flag.
  const model = (claudeMode || codexMode || piMode) && payload.model ? payload.model : undefined
  const family = mode === 'gemini' ? 'antigravity' : mode === 'terminal' ? null : mode
  const launchProfileId =
    family && payload.profile
      ? profilesFor(family).find(
          (profile) =>
            profile.id === payload.profile ||
            profile.name.toLowerCase() === payload.profile!.toLowerCase()
        )?.id
      : undefined
  if (payload.profile && family && !launchProfileId)
    throw new Error(`Unknown ${family} launch profile "${payload.profile}"`)
  // The Claude account: the one named, else the one selected in settings —
  // the same rule the launcher applies, so an agent-opened tab lands on the
  // account the user would have got from the button. Never for another agent.
  const claudeProfile = claudeMode ? resolveAccountForSpawn(payload.account) : null
  if (payload.account && !claudeMode) {
    throw new Error(`The account argument applies to claude mode only (got mode "${mode}")`)
  }
  const accountFields = claudeProfile ? claudeProfileSpawnFields(claudeProfile) : {}
  const info = await window.electronAPI.spawnSession(payload.cwd, {
    claudeMode,
    antigravityMode,
    codexMode,
    piMode,
    dangerousMode,
    model,
    launchProfileId,
    ...accountFields,
    piProvider: piMode ? payload.provider : undefined,
    piThinking: piMode ? payload.thinking : undefined,
    initialCommand: mode === 'terminal' ? payload.command || undefined : undefined,
    autoExecute: mode === 'terminal' && !!payload.command && payload.autoRun !== false,
    initialPrompt: mode !== 'terminal' ? payload.prompt || undefined : undefined,
    workspaceId
  })

  state.addSession({
    id: info.id,
    cwd: info.cwd,
    folderName: info.folderName,
    name: info.folderName,
    alive: info.alive,
    activityStatus: 'idle',
    promptWaiting: null,
    claudeMode,
    antigravityMode,
    codexMode,
    piMode,
    claudeAgentsMode: false,
    dangerousMode,
    model: info.model,
    // Parent link for clave_send_to_session/"parent" — only set when the open
    // came from inside another tab (agent delegation), not from the app UI.
    spawnedBy: payload.callerSessionId || undefined,
    claudeSessionId: info.claudeSessionId ?? null,
    piSessionId: info.piSessionId ?? null,
    launchProfileId: info.launchProfileId,
    piProvider: info.piProvider,
    piThinking: info.piThinking,
    claudeProfileId: claudeProfile?.id,
    claudeProfileLabel: claudeProfile?.label,
    claudeConfigDir: claudeProfile?.configDir || undefined,
    // Persist so Duplicate re-primes the clone with the same prompt.
    initialPrompt: mode !== 'terminal' ? payload.prompt || undefined : undefined,
    sessionType: 'local',
    detectedUrl: null,
    serverStatus: null,
    serverCommand: null,
    hasUnseenActivity: false,
    userRenamed: false,
    planFilePath: null,
    workspaceId
  })
  // renameSession sets userRenamed, protecting the name from auto-title overwrite.
  if (payload.name) useSessionStore.getState().renameSession(info.id, payload.name)
  // An agent that asked for a group gets one; one that didn't is left where
  // addSession put it — the sidebar's first row, top level. (There used to be
  // a pull-back here: addSession nested a new tab into whatever group held the
  // user's selection, which an agent spawn must never inherit. addSession does
  // not nest at all now, so there is nothing to undo.)
  if (targetGroup) {
    useSessionStore.getState().moveItems([info.id], targetGroup.id, 'inside')
  }

  // Agent-delegation spawns are transport events (PRDCT-1568): record them
  // with their launch prompt. UI-originated opens have no caller identity and
  // are the human's own act, not transport — never captured. Terminals are
  // not agents; not captured either.
  if (payload.callerSessionId && mode !== 'terminal' && mode !== 'pi') {
    const current = useSessionStore.getState().sessions
    const spawner = current.find((s) => s.id === payload.callerSessionId)
    const spawned = current.find((s) => s.id === info.id)
    if (spawner && spawned) {
      window.electronAPI.captureTabSpawn({
        ts: new Date().toISOString(),
        spawner: captureEndpointOf(spawner, useSessionStore.getState().groups),
        session: captureEndpointOf(spawned, useSessionStore.getState().groups),
        prompt: payload.prompt || null,
        model: model ?? null
      })
    }
  }

  const groups = useSessionStore.getState().groups
  return { sessionId: info.id, groupId: groupOfSession(groups, info.id)?.id ?? null }
}

function handleMoveSession(payload: {
  sessionId: string
  groupId: string
  callerSessionId?: string
}): unknown {
  const state = useSessionStore.getState()
  if (!state.sessions.some((s) => s.id === payload.sessionId)) {
    throw new Error(`No session with id "${payload.sessionId}"`)
  }
  if (payload.groupId === 'root') {
    // The explicit ungroup: a null target is the top level, at the end.
    state.moveItems([payload.sessionId], null, 'after')
  } else {
    const group = resolveGroup(state.groups, payload.groupId, payload.callerSessionId)
    state.moveItems([payload.sessionId], group.id, 'inside')
    alignSessionToGroupWorkspace(payload.sessionId, group)
  }
  const groups = useSessionStore.getState().groups
  return {
    sessionId: payload.sessionId,
    groupId: groupOfSession(groups, payload.sessionId)?.id ?? null
  }
}

async function handleAddGroupTerminal(payload: {
  groupId: string
  command: string
  commandMode?: 'prefill' | 'auto'
  color?: string
  icon?: string
  cwd?: string
  serverUrl?: string
  groupView?: boolean
  launch?: boolean
  callerSessionId?: string
}): Promise<unknown> {
  const state = useSessionStore.getState()
  const group = resolveGroup(state.groups, payload.groupId, payload.callerSessionId)
  const commandMode = payload.commandMode ?? 'auto'
  if (payload.groupView && !payload.serverUrl) {
    throw new Error('groupView requires a serverUrl — the group view shows that URL')
  }

  const groupCwd =
    group.cwd ?? state.sessions.find((s) => group.sessionIds.includes(s.id))?.cwd ?? null
  const cwd = payload.cwd ?? groupCwd
  if (!cwd) {
    throw new Error('Group has no working directory — pass an explicit cwd')
  }

  const terminalId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  state.addGroupTerminal(group.id, {
    id: terminalId,
    command: payload.command,
    commandMode,
    color: (payload.color as GroupTerminalConfig['color']) ?? 'green',
    icon: (payload.icon as GroupTerminalConfig['icon']) ?? 'terminal',
    // Per-terminal cwd is stored only when it differs from the group default.
    cwd: payload.cwd && payload.cwd !== groupCwd ? payload.cwd : null,
    serverUrl: payload.serverUrl,
    // Carried on the config, not just applied once: a pin resync or an export
    // writes it back as the `.clave` file's `groupView`, so the view survives
    // the next launch of the group.
    groupView: payload.groupView === true ? true : undefined
  })

  // groupView binds the served URL as the group's web view (what the user sees
  // when clicking the group). Attach only — never steal the user's screen.
  if (payload.groupView && payload.serverUrl) {
    useSessionStore.getState().setGroupView(group.id, {
      url: payload.serverUrl,
      title: payload.command || undefined,
      terminalId
    })
  }

  if (payload.launch === false) return { terminalId, groupId: group.id, sessionId: null }

  // Same flow as the sidebar's spawnGroupTerminal: the session is linked to the
  // terminal config (icon click focuses it), not added to the group's tab list.
  const info = await window.electronAPI.spawnSession(cwd, {
    claudeMode: false,
    initialCommand: payload.command || undefined,
    autoExecute: !!payload.command && commandMode === 'auto',
    // Group terminals live in their group's workspace, not the active one.
    workspaceId: group.workspaceId ?? undefined,
    // Owner on the record: what brings it back inside the group next launch.
    link: { kind: 'group-terminal', groupId: group.id, terminalId }
  })
  // PTYs spawn lazily on the first sized start() — normally the visible pane's
  // measure. A terminal spawned into a hidden workspace (or behind an active
  // group view) has no measured pane, so kick it or the command never runs.
  window.electronAPI.startSession(info.id, 120, 30)
  const current = useSessionStore.getState()
  useSessionStore.setState({
    sessions: [
      ...current.sessions,
      {
        id: info.id,
        cwd: info.cwd,
        folderName: info.folderName,
        name: info.folderName,
        alive: info.alive,
        activityStatus: 'idle' as const,
        promptWaiting: null,
        claudeMode: false,
        antigravityMode: false,
        codexMode: false,
        dangerousMode: false,
        claudeSessionId: info.claudeSessionId ?? null,
        sessionType: 'local' as const,
        detectedUrl: null,
        serverStatus: null,
        serverCommand: null,
        hasUnseenActivity: false,
        userRenamed: false,
        planFilePath: null,
        workspaceId: group.workspaceId
      }
    ],
    // Focus only when the group's workspace is the visible one — a terminal
    // added to a hidden workspace's group must not steal the user's view.
    ...(inActiveWorkspace(
      { workspaceId: group.workspaceId },
      useWorkspaceStore.getState().activeWorkspaceId
    )
      ? { selectedSessionIds: [info.id], focusedSessionId: info.id }
      : {})
  })
  current.setGroupTerminalSessionId(group.id, terminalId, info.id)
  return { terminalId, groupId: group.id, sessionId: info.id }
}

async function handleSetGroupView(payload: {
  groupId: string
  url: string | null
  title?: string
  terminalId?: string
  callerSessionId?: string
}): Promise<unknown> {
  const state = useSessionStore.getState()
  const group = resolveGroup(state.groups, payload.groupId, payload.callerSessionId)

  if (payload.url === null) {
    state.setGroupView(group.id, null)
    return { groupId: group.id, view: null }
  }

  const url = payload.url.trim()
  const isFile = url.startsWith('/')
  if (isFile) {
    if (!/\.html?$/i.test(url)) {
      throw new Error('A file view must be an .html/.htm file (or pass an http(s) URL)')
    }
    const slash = url.lastIndexOf('/')
    try {
      const stat = await window.electronAPI.statFile(
        url.substring(0, slash) || '/',
        url.substring(slash + 1)
      )
      if (stat.type === 'directory') throw new Error('directory')
    } catch {
      throw new Error(`No file at "${url}"`)
    }
  } else if (!/^https?:\/\//i.test(url)) {
    throw new Error('url must be an http(s) URL or an absolute .html file path')
  }

  if (payload.terminalId && !group.terminals.some((t) => t.id === payload.terminalId)) {
    throw new Error(`Group has no terminal "${payload.terminalId}"`)
  }

  const view: GroupViewConfig = {
    url,
    title: payload.title,
    terminalId: payload.terminalId ?? null
  }
  state.setGroupView(group.id, view)
  // Mark the serving terminal so the binding survives where the group does
  // (sidebar-layout serializes groups whole; a pin resync writes it into the
  // .clave file). Only when the linked terminal genuinely serves this page:
  // marking one whose serverUrl points elsewhere would rebind the view later.
  const linked = payload.terminalId
    ? group.terminals.find((t) => t.id === payload.terminalId)
    : undefined
  if (linked && linked.serverUrl === url && !linked.groupView) {
    useSessionStore.getState().updateGroupTerminal(group.id, linked.id, { groupView: true })
  }
  return { groupId: group.id, view }
}

async function handleSetSessionView(payload: {
  sessionId: string
  url: string | null
  title?: string
  command?: string
  cwd?: string
  callerSessionId?: string
}): Promise<unknown> {
  const state = useSessionStore.getState()
  const id = payload.sessionId === 'mine' ? payload.callerSessionId : payload.sessionId
  if (!id) throw new Error('sessionId "mine" needs a caller session — pass an explicit id')
  const session = state.sessions.find((s) => s.id === id)
  if (!session) throw new Error(`No session with id "${payload.sessionId}"`)

  if (payload.url === null) {
    // Detach: the hidden serving session goes with the view — nothing else
    // owns it. removeSession also cascades, but a detach must not wait for
    // the owner to close.
    const servingId = session.view?.serverSessionId
    if (servingId) {
      window.electronAPI.killSession(servingId).catch(() => {})
      useSessionStore.setState((current) => ({
        sessions: current.sessions.filter((s) => s.id !== servingId)
      }))
    }
    useSessionStore.getState().setSessionView(id, null)
    return { sessionId: id, view: null }
  }

  const url = payload.url.trim()
  const isFile = url.startsWith('/')
  if (isFile) {
    if (!/\.html?$/i.test(url)) {
      throw new Error('A file view must be an .html/.htm file (or pass an http(s) URL)')
    }
    const slash = url.lastIndexOf('/')
    try {
      const stat = await window.electronAPI.statFile(
        url.substring(0, slash) || '/',
        url.substring(slash + 1)
      )
      if (stat.type === 'directory') throw new Error('directory')
    } catch {
      throw new Error(`No file at "${url}"`)
    }
    if (payload.command)
      throw new Error('A file view has no server — command only applies to http(s) URLs')
  } else if (!/^https?:\/\//i.test(url)) {
    throw new Error('url must be an http(s) URL or an absolute .html file path')
  }

  // A previous serving session is replaced, not leaked.
  const previousServing = session.view?.serverSessionId
  if (previousServing) {
    window.electronAPI.killSession(previousServing).catch(() => {})
    useSessionStore.setState((current) => ({
      sessions: current.sessions.filter((s) => s.id !== previousServing)
    }))
  }

  let serverSessionId: string | null = null
  if (payload.command) {
    // The serving session launches itself at attach — same contract as
    // clave_add_group_terminal's default. Hidden: appended to sessions only,
    // never to displayOrder or a group, so no row appears (and addSession is
    // bypassed for the same reason the group-terminal spawn bypasses it —
    // it would steal focus and auto-nest into the selected group).
    const info = await window.electronAPI.spawnSession(payload.cwd ?? session.cwd, {
      claudeMode: false,
      initialCommand: payload.command,
      autoExecute: true,
      workspaceId: session.workspaceId ?? undefined,
      // Owner on the record: what brings it back as this view's server rather
      // than as a tab of its own next launch.
      link: { kind: 'session-view', ownerId: id }
    })
    // Hidden pane, zero size: kick the PTY or the command never runs.
    window.electronAPI.startSession(info.id, 120, 30)
    useSessionStore.setState((current) => ({
      sessions: [
        ...current.sessions,
        {
          id: info.id,
          cwd: info.cwd,
          folderName: info.folderName,
          name: info.folderName,
          alive: info.alive,
          activityStatus: 'idle' as const,
          promptWaiting: null,
          claudeMode: false,
          antigravityMode: false,
          codexMode: false,
          dangerousMode: false,
          claudeSessionId: info.claudeSessionId ?? null,
          sessionType: 'local' as const,
          detectedUrl: null,
          serverStatus: null,
          serverCommand: null,
          hasUnseenActivity: false,
          userRenamed: false,
          planFilePath: null,
          workspaceId: session.workspaceId
        }
      ]
    }))
    serverSessionId = info.id
  }

  const view = {
    url,
    title: payload.title,
    command: payload.command,
    cwd: payload.cwd,
    serverSessionId
  }
  // Attach only — never steal what the user is looking at; they see the view
  // on the row's dashboard icon (or their next click of it).
  useSessionStore.getState().setSessionView(id, view)
  return { sessionId: id, view: { url, title: payload.title } }
}

async function handleCloseSession(payload: {
  sessionId: string
  callerSessionId?: string
}): Promise<unknown> {
  const state = useSessionStore.getState()
  const session = state.sessions.find((s) => s.id === payload.sessionId)
  if (!session) throw new Error(`No session with id "${payload.sessionId}"`)
  // An agent-initiated close is a transport event: recorded with the closing
  // tab as `closer` BEFORE the kill, while the identity is still in the store.
  const closer = payload.callerSessionId
    ? (state.sessions.find((s) => s.id === payload.callerSessionId) ?? null)
    : null
  emitTabClosed(session, state.groups, 'agent', closer)
  await window.electronAPI.killSession(payload.sessionId)
  useSessionStore.getState().removeSession(payload.sessionId)
  return { closed: payload.sessionId }
}

function handleRename(payload: { target: 'group' | 'session'; id: string; name: string }): unknown {
  const state = useSessionStore.getState()
  if (payload.target === 'group') {
    if (!state.groups.some((g) => g.id === payload.id)) {
      throw new Error(`No group with id "${payload.id}"`)
    }
    state.renameGroup(payload.id, payload.name)
  } else {
    if (!state.sessions.some((s) => s.id === payload.id)) {
      throw new Error(`No session with id "${payload.id}"`)
    }
    state.renameSession(payload.id, payload.name)
  }
  return { renamed: payload.id, name: payload.name }
}

/** Collapse '.' and '..' segments of an absolute path (no node:path in the renderer). */
function normalizePath(absPath: string): string {
  const segments: string[] = []
  for (const segment of absPath.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return '/' + segments.join('/')
}

async function handleOpenFile(payload: {
  path: string
  name?: string
  view?: 'rendered' | 'source'
  callerSessionId?: string
}): Promise<unknown> {
  const state = useSessionStore.getState()
  let abs = payload.path
  if (!abs.startsWith('/')) {
    const caller = state.sessions.find((s) => s.id === payload.callerSessionId)
    if (!caller) {
      throw new Error(
        'A relative path requires the call to come from inside a Clave tab — pass an absolute path'
      )
    }
    abs = `${caller.cwd}/${abs}`
  }
  abs = normalizePath(abs)
  const slash = abs.lastIndexOf('/')
  const parentDir = abs.substring(0, slash) || '/'
  const fileName = abs.substring(slash + 1)

  let stat: { type: 'file' | 'directory' }
  try {
    stat = await window.electronAPI.statFile(parentDir, fileName)
  } catch {
    throw new Error(`No file at "${abs}"`)
  }
  if (stat.type === 'directory') {
    throw new Error(`"${abs}" is a directory — clave_open_file opens files only`)
  }

  // The view pin only means something for HTML files (rendered is their
  // default anyway; source pins the code editor). Other kinds ignore it.
  const isHtml = /\.(html?|htm)$/i.test(fileName)

  // addFileTab dedups by path: an already-open file just gets focused (and
  // retargeted when an explicit view is requested).
  state.addFileTab({
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    filePath: abs,
    name: payload.name ?? fileName,
    ...(isHtml && payload.view ? { view: payload.view } : {})
  })
  const tab = useSessionStore.getState().fileTabs.find((f) => fileTabDedupKey(f) === `file:${abs}`)
  return { fileTabId: tab?.id ?? null, filePath: abs }
}

async function handleNotify(payload: {
  title: string
  body: string
  sessionId?: string
  callerSessionId?: string
}): Promise<unknown> {
  const state = useSessionStore.getState()
  if (payload.sessionId && !state.sessions.some((s) => s.id === payload.sessionId)) {
    throw new Error(`No session with id "${payload.sessionId}"`)
  }
  const sessionId = payload.sessionId ?? payload.callerSessionId
  if (!sessionId) {
    throw new Error('Pass sessionId — this call did not come from inside a Clave tab')
  }
  const status = await window.electronAPI.showNotification({
    title: payload.title,
    body: payload.body,
    sessionId
  })
  return { status, sessionId }
}

/** Cross-window session resolution (main calls this in EVERY window when an
 *  MCP subject is a NAME, not an id): does THIS window's store hold a local
 *  session with that id or exact name? Main collects the hits and routes the
 *  command to the one window that owns the ref (ambiguity across windows is
 *  rejected there, as within a window). Never resolves "mine"/"parent" —
 *  those stay in the caller's window. */
function handleResolveSessionRef(payload: { ref: string }): unknown {
  const windowId = useWorkspaceStore.getState().windowId
  if (payload.ref === 'mine' || payload.ref === 'parent') {
    return { found: false, windowId }
  }
  const sessions = useSessionStore.getState().sessions.filter((s) => s.sessionType === 'local')
  const found =
    sessions.find((s) => s.id === payload.ref) ?? sessions.find((s) => s.name === payload.ref)
  return found
    ? { found: true, sessionId: found.id, name: found.name, windowId }
    : { found: false, windowId }
}

/** Resolve a messaging/readback target: a session id, an exact tab name, or
 *  "parent" (the tab whose agent opened the caller via clave_open_session). */
function resolveTargetSession(ref: string, callerSessionId: string | undefined): Session {
  const sessions = useSessionStore.getState().sessions.filter((s) => s.sessionType === 'local')
  if (ref === 'parent') {
    if (!callerSessionId) {
      throw new Error('Target "parent" requires the call to come from inside a Clave session')
    }
    const caller = sessions.find((s) => s.id === callerSessionId)
    const parent = caller?.spawnedBy ? sessions.find((s) => s.id === caller.spawnedBy) : undefined
    if (!parent) {
      throw new Error(
        'This session has no live parent — only tabs opened via clave_open_session know their opener, and the link does not survive an app restart. Use clave_list and target a session id or name instead.'
      )
    }
    return parent
  }
  const found = sessions.find((s) => s.id === ref) ?? sessions.find((s) => s.name === ref)
  if (!found) throw new Error(`No session with id or name "${ref}"`)
  return found
}

/**
 * Cross-tab reach gate: a tab may send to / read only a target it has a real
 * relationship with — one it opened, the one that opened it ("parent"), or one
 * the user placed in the same group. This keeps a single poisoned tab from
 * driving or reading tabs in unrelated projects; grouping is the explicit
 * "these tabs may talk" gesture for anything outside the spawn lineage.
 * Identity is the token-derived callerSessionId (unforgeable), so the gate is
 * enforceable — a tab cannot claim to be the target's parent.
 */
function assertCanReach(
  callerSessionId: string | undefined,
  target: Session,
  verb: 'message' | 'read'
): void {
  // Identity is the token-derived callerSessionId (unforgeable), NOT the
  // caller's presence in THIS window's store: with several windows the caller
  // may live in another window's store while its target is hosted here (main
  // routed the call to the target's window, §3.8). So the id alone proves the
  // request came from a real tab; the relationship is then judged from
  // whatever this store can see.
  if (!callerSessionId) {
    throw new Error(
      `clave_${verb === 'message' ? 'send_to' : 'read'}_session must be called from inside a Clave agent tab — this request has no tab identity.`
    )
  }
  if (callerSessionId === target.id) return
  const state = useSessionStore.getState()
  // The caller record is available only when it lives in this window. The
  // "I opened target" relationship is verifiable WITHOUT it — `target.spawnedBy`
  // is set by main at spawn and lives on the target, here — so a tab reaching a
  // tab it opened works across windows. The "target opened me" (parent) and
  // "same group" relationships need the caller's own record, so they resolve
  // only within one window (parent stays caller-window by design, §3.8).
  const caller = state.sessions.find((s) => s.id === callerSessionId)
  const related =
    target.spawnedBy === callerSessionId || // I opened target (my child) — cross-window
    (!!caller &&
      (target.id === caller.spawnedBy || // target opened me (my parent) — same window
        state.groups.some(
          (g) => g.sessionIds.includes(caller.id) && g.sessionIds.includes(target.id)
        )))
  if (!related) {
    throw new Error(
      `Refusing to ${verb} tab "${target.name}": it is not related to yours. You can only reach the tab that opened yours ("parent"), tabs you opened, or tabs in the same group. Put both tabs in one group to allow this.`
    )
  }
}

/**
 * Strip control bytes that would break the bracketed-paste envelope or be
 * interpreted as keystrokes/escape sequences by the receiving TUI. Newlines
 * and tabs are safe *inside* a paste and kept; everything else below 0x20
 * (plus DEL) is removed. This is the load-bearing guard against paste
 * breakout: without removing ESC (0x1b), a literal `\x1b[201~` in the message
 * would close the paste early and turn the remainder into live keystrokes —
 * enough to clear the input and enter Claude's `!` bash mode (RCE across
 * tabs). With ESC/CR/etc. gone, the whole message stays pasted text under the
 * provenance header and our single trailing submit sends it as one turn.
 */
function sanitizeForPaste(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

// Serialize writes per target so two concurrent sends can't interleave their
// paste envelopes (envelope-A, envelope-B, submit-A, submit-B → one garbled
// turn). Keyed by target session id; each send appends to the target's chain.
const sendChains = new Map<string, Promise<unknown>>()

/**
 * A self-addressed send is a CHECKPOINT: the session's internal note, logged
 * into the transport record, never delivered. The entire delivery machinery
 * is deliberately unreachable from here — no paste envelope, no submit, no
 * draft stash, no send chain, no sidebar markers — so nothing can ever be
 * typed into any tab; the only effect is one ordinary message event with
 * sender = target in the store, which the exos watcher captures like any
 * other message (a solo lane's narrative, the phases deriving from
 * headline-first checkpoints). `delivered` stays false — nothing was
 * delivered, and the self-pair is what tells a checkpoint from a failed
 * delivery. The text is sanitized exactly like a real delivery so the store
 * holds one consistent form.
 */
function handleSelfCheckpoint(sessionId: string, message: string): unknown {
  const state = useSessionStore.getState()
  // Same notion of "a session" as resolveTargetSession: local tabs only, so
  // the two paths cannot quietly diverge on what may enter the record.
  const self = state.sessions.find((s) => s.sessionType === 'local' && s.id === sessionId)
  if (!self) throw new Error('Calling session not found')
  if (sessionMode(self) === 'pi') throw new Error('Pi exchange capture is not supported yet')
  const text = sanitizeForPaste(message)
  const endpoint = captureEndpointOf(self, state.groups)
  window.electronAPI.captureExchangeMessage({
    ts: new Date().toISOString(),
    sender: endpoint,
    target: endpoint,
    text,
    provenance: buildCheckpointProvenance({ id: self.id, name: self.name }),
    delivered: false
  })
  return {
    checkpoint: true,
    logged: true,
    delivered: false,
    sessionId: self.id,
    name: self.name,
    note: 'Checkpoint logged to the transport record; nothing was typed into any tab.'
  }
}

async function handleSendToSession(payload: {
  sessionId: string
  message: string
  callerSessionId?: string
}): Promise<unknown> {
  // "mine", the caller's own id, or the caller's own tab name all mean the
  // checkpoint path — resolved BEFORE the reach gate, which has nothing to
  // gate on a message that never leaves the session.
  if (payload.callerSessionId && payload.sessionId === 'mine') {
    assertMigrationComplete(resolveTargetSession(payload.callerSessionId, payload.callerSessionId))
    return handleSelfCheckpoint(payload.callerSessionId, payload.message)
  }
  const target = resolveTargetSession(payload.sessionId, payload.callerSessionId)
  assertMigrationComplete(target)
  if (payload.callerSessionId && target.id === payload.callerSessionId) {
    return handleSelfCheckpoint(payload.callerSessionId, payload.message)
  }
  assertCanReach(payload.callerSessionId, target, 'message')
  if (!target.alive) throw new Error(`Session "${target.name}" has ended`)
  const mode = sessionMode(target)
  if (mode === 'terminal' && !target.id.startsWith('conversation-')) {
    throw new Error(
      'Refusing to send to a plain terminal — text typed there would run as a shell command. Target an agent tab (claude/antigravity/codex).'
    )
  }
  if (mode === 'claude-agents') {
    throw new Error('Refusing to send to a `claude agents` tab — it is a menu UI, not a chat input')
  }
  const sender = payload.callerSessionId
    ? useSessionStore.getState().sessions.find((s) => s.id === payload.callerSessionId)
    : undefined
  // Provenance header: the receiving agent must be able to tell this text came
  // from a sibling tab, not from the user — and know how to answer it. Built
  // from the shared module so the capture's transcript parser matches the same
  // string it stamps here (a drifted copy would silently relabel a sibling's
  // message as the human's).
  const header = buildProvenanceHeader(sender)
  // Sanitize BOTH parts (header + message): a tab renamed to carry control
  // bytes must not be able to smuggle them in via the header either. Parts
  // are sanitized separately (the per-character filter distributes over
  // concatenation, so this equals sanitizing the joined text) so the capture
  // below can record exactly what was delivered under which provenance.
  const cleanHeader = sanitizeForPaste(header)
  const cleanMessage = sanitizeForPaste(payload.message)
  const text = `${cleanHeader}\n${cleanMessage}`

  const targetId = target.id

  if (targetId.startsWith('conversation-')) {
    await window.electronAPI.conversations.send(targetId, text, crypto.randomUUID())
    useSessionStore.getState().setSessionInjectedFrom(targetId, sender?.name ?? 'another tab')
    return { delivered: true, sessionId: targetId, name: target.name, mode, draftHandling: 'none' }
  }

  // Set once the SUBMIT below has landed — the moment the message exists in
  // the target. The capture (see the chain wiring) keys off this and NOT off
  // the draft restore that follows, so a failed or best-effort restore can
  // neither suppress the record nor change `delivered`.
  let submitted = false

  // PRDCT-1569: the target CLI's input buffer may hold the user's half-typed
  // draft, which would otherwise be co-submitted with (and swallowed by) the
  // injected turn. Stash the tracked draft, clear the input line, deliver
  // header+message and submit ALONE, then restore the draft unsubmitted.
  // The whole sequence lives inside one per-target chain link so a concurrent
  // send cannot interleave with the restore.
  //
  // Degraded-case stance: when the shadow's tracking confidence is lost
  // (word ops, history recall, completions, dialog input…) we still deliver —
  // never hold the message on screen-scraping the TUI — clearing with a
  // cushioned overshoot built only from keys verified inert both at the input
  // boundary and inside the CLI's dialogs (see draft-shadow.ts; undershoot
  // would leave residue to co-submit). The degradation is reported ONLY in
  // this tool's result (draftHandling) — nothing in the app UI shows it.
  const runInjection = async (): Promise<DraftStash> => {
    const shadow = getDraftShadow(targetId)
    const stash = shadow.beginInjection()
    try {
      if (stash.clear) {
        window.electronAPI.writeSession(targetId, stash.clear)
        await new Promise((r) => setTimeout(r, 150))
      }
      // Deliver as one bracketed paste so embedded newlines don't submit early,
      // then submit. The TUI queues input that arrives mid-turn, so a busy agent
      // sees the message as its next user turn.
      window.electronAPI.writeSession(targetId, `\x1b[200~${text}\x1b[201~`)
      await new Promise((r) => setTimeout(r, 150))
      window.electronAPI.writeSession(targetId, '\r')
      submitted = true
      if (stash.text) {
        // Give the TUI a beat to consume the submit, then re-paste the draft
        // with NO trailing submit — same sanitize + bracketed-paste discipline
        // as the message itself (the draft is user text, not keystrokes).
        await new Promise((r) => setTimeout(r, 150))
        window.electronAPI.writeSession(
          targetId,
          `\x1b[200~${sanitizeForPaste(stash.text)}\x1b[201~`
        )
      }
    } finally {
      shadow.endInjection(stash.text)
    }
    return stash
  }

  const prior = sendChains.get(targetId) ?? Promise.resolve()
  const run = prior.catch(() => {}).then(runInjection)
  sendChains.set(targetId, run)
  run.finally(() => {
    // Drop the chain once it drains so the map doesn't grow unboundedly.
    if (sendChains.get(targetId) === run) sendChains.delete(targetId)
  })
  // Transport-layer capture (PRDCT-1568), on a chain of its own so the delivery
  // never waits on it: it records the message once the submit has landed, and
  // fires on BOTH settle paths — a restore that failed still delivered a
  // message, and the record must show that. Fire-and-forget IPC, off the
  // stash->restore critical path. `sender` is always set here: assertCanReach
  // refused identity-less callers above.
  if (sender) {
    const recordDelivery = (): void => {
      if (!submitted) return
      if (sessionMode(sender) === 'pi' || sessionMode(target) === 'pi') return
      window.electronAPI.captureExchangeMessage({
        ts: new Date().toISOString(),
        sender: captureEndpointOf(sender, useSessionStore.getState().groups),
        target: captureEndpointOf(target, useSessionStore.getState().groups),
        text: cleanMessage,
        provenance: cleanHeader,
        delivered:
          useSessionStore.getState().sessions.find((s) => s.id === targetId)?.alive === true
      })
    }
    void run.then(recordDelivery, recordDelivery)
  }
  const stash = await run

  // The target can exit during the 150ms envelope→submit gap; the PTY write is
  // then a silent no-op, so report what actually happened rather than a blanket
  // delivered:true.
  const stillAlive =
    useSessionStore.getState().sessions.find((s) => s.id === targetId)?.alive === true
  if (stillAlive) {
    // Visible, non-spoofable signal that a sibling wrote here — the sidebar
    // marks the tab and names the sender, so a cross-tab message is never
    // silent even if the user isn't looking at the target tab.
    const store = useSessionStore.getState()
    store.setSessionInjectedFrom(targetId, sender?.name ?? 'another tab')
    if (!store.selectedSessionIds.includes(targetId)) store.setSessionUnseenActivity(targetId, true)
  }
  // How the user's pending input draft was handled: 'none' (input believed
  // empty, nothing touched), 'stashed-restored' (draft cleared before the
  // injected turn and re-pasted unsubmitted after it), or the best-effort
  // variant when keystroke tracking had lost confidence.
  const draftHandling = stash.confident
    ? stash.text
      ? 'stashed-restored'
      : 'none'
    : 'stashed-restored-best-effort'
  return {
    delivered: stillAlive,
    sessionId: targetId,
    name: target.name,
    mode,
    agentState: target.agentState ?? null,
    draftHandling
  }
}

function assertMigrationComplete(session: Session): void {
  if (session.legacyAgentId) {
    throw new Error('Session migration required. Open this tab in Clave and move it to a conversation before reading or sending messages.')
  }
}

async function handleReadSession(payload: {
  sessionId: string
  lines?: number
  callerSessionId?: string
}): Promise<unknown> {
  const target = resolveTargetSession(payload.sessionId, payload.callerSessionId)
  assertCanReach(payload.callerSessionId, target, 'read')
  assertMigrationComplete(target)
  if (target.id.startsWith('conversation-')) {
    const snapshot = await window.electronAPI.conversations.snapshot(target.id)
    const requested = Math.min(Math.max(payload.lines ?? 100, 1), 500)
    const lines = snapshot.entries.flatMap((entry) => {
      switch (entry.kind) {
        case 'message': return `${entry.role}: ${entry.text}`.split('\n')
        case 'artifact': return `${entry.title}\n${entry.fallback}`.split('\n')
        case 'tool': return `${entry.name} (${entry.status})\n${entry.input ?? ''}\n${entry.output ?? ''}`.split('\n')
      }
    }).slice(-requested)
    return {
      sessionId: target.id, name: target.name, mode: snapshot.session.provider,
      alive: snapshot.session.status !== 'closed', agentState: snapshot.session.status,
      lines: lines.length, text: lines.join('\n')
    }
  }
  const terminal = getRegisteredTerminal(target.id)
  if (!terminal) {
    throw new Error(`Session "${target.name}" has no terminal buffer (tab not mounted yet)`)
  }
  const requested = Math.min(Math.max(payload.lines ?? 100, 1), 500)
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let i = Math.max(0, buffer.length - requested); i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  }
  // The TUI viewport is mostly blank padding — drop trailing empty rows.
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  return {
    sessionId: target.id,
    name: target.name,
    mode: sessionMode(target),
    alive: target.alive,
    agentState: target.agentState ?? null,
    lines: lines.length,
    text: lines.join('\n')
  }
}

function handleFocus(payload: { sessionId: string }): unknown {
  const state = useSessionStore.getState()
  const target = state.sessions.find((s) => s.id === payload.sessionId)
  if (!target) {
    throw new Error(`No session with id "${payload.sessionId}"`)
  }
  // An explicit focus request must be honored VISIBLY: focusing a session in a
  // hidden workspace switches the whole view to that workspace first.
  const activeId = useWorkspaceStore.getState().activeWorkspaceId
  if (target.workspaceId && activeId && target.workspaceId !== activeId) {
    void setActiveWorkspace(target.workspaceId)
  }
  useSessionStore.getState().selectSession(payload.sessionId, false)
  return { focused: payload.sessionId, workspaceId: target.workspaceId ?? null }
}

function handleSwitchWorkspace(payload: { workspace: string }): unknown {
  const ws = resolveWorkspace(payload.workspace)
  void setActiveWorkspace(ws.id)
  return { activeWorkspaceId: ws.id, name: ws.name }
}

async function execute(command: string, payload: unknown): Promise<unknown> {
  switch (command) {
    case 'list':
      return handleList(payload as Parameters<typeof handleList>[0])
    case 'resolveSessionRef':
      return handleResolveSessionRef(payload as { ref: string })
    case 'createGroup':
      return handleCreateGroup(payload as Parameters<typeof handleCreateGroup>[0])
    case 'openSession':
      return openSessionProgrammatically(
        payload as Parameters<typeof openSessionProgrammatically>[0]
      )
    case 'moveSession':
      return handleMoveSession(payload as Parameters<typeof handleMoveSession>[0])
    case 'launchGroup':
      return handleLaunchGroup(payload as Parameters<typeof handleLaunchGroup>[0])
    case 'addGroupTerminal':
      return handleAddGroupTerminal(payload as Parameters<typeof handleAddGroupTerminal>[0])
    case 'setGroupView':
      return handleSetGroupView(payload as Parameters<typeof handleSetGroupView>[0])
    case 'setSessionView':
      return handleSetSessionView(payload as Parameters<typeof handleSetSessionView>[0])
    case 'closeSession':
      return handleCloseSession(payload as Parameters<typeof handleCloseSession>[0])
    case 'rename':
      return handleRename(payload as Parameters<typeof handleRename>[0])
    case 'focus':
      return handleFocus(payload as Parameters<typeof handleFocus>[0])
    case 'switchWorkspace':
      return handleSwitchWorkspace(payload as Parameters<typeof handleSwitchWorkspace>[0])
    case 'sendToSession':
      return handleSendToSession(payload as Parameters<typeof handleSendToSession>[0])
    case 'readSession':
      return handleReadSession(payload as Parameters<typeof handleReadSession>[0])
    case 'flushLinkedDocument': {
      const p = payload as { sessionId: string; allowConflict?: boolean }
      await flushLinkedDocument(p.sessionId, p.allowConflict)
      return { flushed: true }
    }
    case 'openLinkedDocument': {
      const p = payload as { callerSessionId?: string; input: LinkedOpen }
      const caller = useSessionStore.getState().sessions.find((s) => s.id === p.callerSessionId)
      if (!caller) throw new Error('Open linked documents from their originating Clave session')
      await flushLinkedDocument(caller.id)
      const result = await window.electronAPI.linkedDocuments.open(caller.id, p.input)
      handleFocus({ sessionId: caller.id })
      return result
    }
    case 'openFile':
      return handleOpenFile(payload as Parameters<typeof handleOpenFile>[0])
    case 'pluginSetDraft': {
      const p = payload as { sessionId: string; text: string }
      const state = conversationComposer.read(p.sessionId)
      if (state.text.length || state.sending) throw new Error('The composer already contains a draft. Clear it before inserting plugin text.')
      conversationComposer.edit(p.sessionId, p.text)
      return { updated: true }
    }
    case 'publishArtifact': {
      const p = payload as import('../../../shared/runtime-plugins').ArtifactInput & {
        callerSessionId?: string; commandId: string
      }
      const caller = useSessionStore.getState().sessions.find((item) => item.id === p.callerSessionId)
      if (!caller?.id.startsWith('conversation-')) throw new Error('Publish artifacts from an authenticated conversation session')
      return window.electronAPI.conversations.publishArtifact(caller.id, {
        title: p.title, mimeType: p.mimeType, content: p.content, fallback: p.fallback, sourceUrl: p.sourceUrl
      }, p.commandId)
    }
    case 'pluginOpenFile': {
      const p = payload as { sessionId: string; path: string }
      return handleOpenFile({ path: p.path, callerSessionId: p.sessionId })
    }
    case 'pluginOpenArtifact': {
      const p = payload as { sessionId: string; entryId: string }
      handleFocus({ sessionId: p.sessionId })
      // Focusing another tab can mount its conversation asynchronously.
      const deadline = Date.now() + 5000
      const selector = `[data-conversation-id="${CSS.escape(p.sessionId)}"] [data-artifact-id="${CSS.escape(p.entryId)}"]`
      while (!document.querySelector(selector)) {
        if (Date.now() >= deadline) throw new Error('Artifact view is not available in this window')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      window.dispatchEvent(new CustomEvent('clave:open-artifact', { detail: p }))
      return { opened: true }
    }
    case 'notify':
      return handleNotify(payload as Parameters<typeof handleNotify>[0])
    default:
      throw new Error(`Unknown MCP command "${command}"`)
  }
}

/** Subscribe to MCP commands from the main process. Returns an unsubscribe fn. */
export function initMcpDispatcher(): () => void {
  return window.electronAPI.onMcpCommand((msg: McpCommandMessage) => {
    void (async () => {
      try {
        const result = await execute(msg.command, msg.payload)
        window.electronAPI.mcpRespond({ requestId: msg.requestId, ok: true, result })
      } catch (err) {
        window.electronAPI.mcpRespond({
          requestId: msg.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })()
  })
}
