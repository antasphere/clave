import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import { ownerOf } from './fleet-identity'
import { useSessionStore } from '../store/session-store'
import { useFleetStore } from '../store/fleet-store'
import { claudeProfileSpawnFields } from '../store/claude-profile-store'
import { codexAccountSpawnFields } from '../store/codex-account-store'
import { accountForLaunch } from './switch-account'
import { rememberedLaunchModel } from './launch-model'
import { getActiveWorkspaceId, getWorkspaceById, workspaceServer } from '../store/workspace-store'
import { pickServerFolder } from '../store/server-folder-store'
import { clearLaunchNotice, showLaunchNotice } from '../store/launch-notice-store'
import { deliverPendingChatView, pendingChatView } from './pending-chat-view'
import {
  profileSetsPermissions,
  type LaunchProfile,
  type LauncherFamily
} from '../../../shared/agent-launch'
import { serverProfilesFor, serverSettingsReady } from '../store/server-settings-state'
import { permissionRungFor, useLaunchSettingsStore } from '../store/launch-settings-store'
import { HARNESS_BY_ID } from '../../../shared/harness'
import { CHAT_PROFILE_IDS, chatDefaultFor } from '../../../shared/open-session-modes'
import {
  profilesFor,
  selectedChatProfile,
  selectedLaunchProfile
} from '../store/launch-profile-store'
import {
  agentAcceptsPrompt,
  agentSetupToModes,
  rememberAgentSetup,
  type AgentSetup
} from '../store/launch-prefs'

/** Where a new session starts.
 *
 *  `workspace-root` is the default for every launcher: the ask is that a new
 *  session lands at the root of the workspace you are in, not at whatever
 *  directory was picked last. It degrades to `ask` in no-workspace mode
 *  (`activeWorkspaceId === null` exactly when no workspace is registered), where
 *  there is no root to default to. */
export type LaunchCwd =
  | { kind: 'workspace-root' }
  | { kind: 'ask' }
  | { kind: 'path'; path: string }

export interface LaunchRequest {
  /** Explicit owner; omit to follow the targeted group, else the workspace. */
  serverId?: string
  /** The agent to run, or null for a plain terminal. */
  setup: AgentSetup | null
  cwd: LaunchCwd
  /** One-shot prompt auto-submitted on launch. Ignored for a plain terminal
   *  (typed text would run as a shell command) and for `claude agents`, which
   *  is spawned bare and rejects a positional prompt — the same two exclusions
   *  the pinned-group spawn path applies. */
  initialPrompt?: string
  /** Group the new session joins, as its first row — the group's own `+`.
   *  Without it the session becomes the sidebar's first top-level row. */
  groupId?: string
  /** Store `setup` as the workspace's remembered default. On for the launcher's
   *  own agent launches (a caret pick is what makes an agent the remembered
   *  one); off for launches that shouldn't redefine the default. */
  remember?: boolean
  /** Opt-in error propagation for callers that must preserve a failed launch. */
  throwOnError?: boolean
  /** Called as soon as main acknowledges creation, before renderer placement. */
  onCreated?: (id: string) => void
  /** Refuse a resolved profile different from the explicit selection. */
  exactProfile?: boolean
  /** Explicit home for a capture-bound launch; ordinary launchers use their current workspace. */
  workspaceId?: string
}

export interface LaunchSelectionError extends Error {
  code: 'launch-profile-mismatch' | 'launch-account-unavailable'
  cleanupSucceeded: boolean
}

/** Resolve a LaunchCwd to an absolute path, opening the native folder picker
 *  when one is needed. Returns null when the user cancels the picker. */
async function resolveCwd(cwd: LaunchCwd): Promise<string | null> {
  if (cwd.kind === 'path') return cwd.path
  if (cwd.kind === 'workspace-root') {
    const root = getWorkspaceById(getActiveWorkspaceId())?.rootDir
    // A registered root can stop existing — a deleted folder, an unmounted
    // volume. Before this change the picker could only ever hand back a real
    // directory; now the root is taken on trust, so it has to be checked or the
    // session spawns at a path that isn't there with no error and no fallback.
    //
    // Deliberately the ASYNC check, not `existsSync`: that one is `sendSync`, and
    // this runs on every ⌘T/⌘N and every launcher click. A stale network mount
    // would freeze the renderer until the stat returned.
    if (root && (await window.electronAPI?.claveFileExists?.(root))) return root
    // No workspace, or its root is gone: nothing to default to, so ask.
  }
  return (await window.electronAPI.openFolderDialog()) ?? null
}

/** The machine a launch runs on (#241): an explicit server, else the
 *  targeted group's owner, else the workspace's — a server workspace starts
 *  its sessions on its server, a workspace of this Mac on this Mac. Nothing
 *  asks: the workspace decides. */
export function launchServer(
  req: Pick<LaunchRequest, 'serverId' | 'groupId' | 'workspaceId'>
): string {
  if (req.serverId !== undefined) return req.serverId
  if (req.groupId) return ownerOf(req.groupId)
  return workspaceServer(req.workspaceId ?? getActiveWorkspaceId()) ?? LOCAL_SERVER_ID
}

type SpawnOptions = NonNullable<Parameters<Window['electronAPI']['spawnSession']>[1]>

/** What the launcher's setup asks of the CLI beyond the family
 *  (PRDCT-4423): the model picked in the menu (its `--model`/`-m`), and,
 *  when the launch does not skip approvals, the permission rung Settings →
 *  Harnesses set as the harness's default. `claude agents` takes neither: it
 *  is a subcommand with no model or permission flag of its own. Cmd+Y keeps
 *  its bypass: a dangerous setup never carries a rung. */
export function setupSpawnFlags(
  setup: AgentSetup | null,
  launchProfileId?: string,
  workspaceId: string | null = null
): Pick<SpawnOptions, 'model' | 'permissionMode'> {
  if (!setup || setup.kind === 'claude-agents') return {}
  // A profile that sets its own permissions keeps them: no default rung
  // travels with it (verifier, round 2). The profile is the one named, else
  // the family's selected one.
  const profile =
    (launchProfileId && profilesFor(setup.kind).find((p) => p.id === launchProfileId)) ||
    selectedLaunchProfile(setup.kind, workspaceId)
  const rung =
    setup.dangerousMode || (profile && profileSetsPermissions(profile))
      ? undefined
      : permissionRungFor(useLaunchSettingsStore.getState().harnesses, setup.kind)
  return {
    ...(setup.model ? { model: setup.model } : {}),
    // The spawn's type names Claude's rungs; the other harnesses' (Codex's
    // sandbox names, Antigravity's) travel as the same string field.
    ...(rung ? { permissionMode: rung as SpawnOptions['permissionMode'] } : {})
  }
}

/**
 * The launch profile a setup runs on when it names none (PRDCT-4425): the
 * family's chat default when the person's interaction mode is a chat view
 * and the harness has a chat adapter, else nothing, which main resolves to
 * the family's terminal profile. One rule for every road, the launcher's
 * rows, the agent button, the keyboard shortcuts and a server launch alike
 * (the verifier's round 1: the button and the shortcuts ignored the mode).
 * `claude agents` is a subcommand with no chat; a Claude chat is not offered
 * on Windows (`launch-profile-manager.ts`), where the terminal stays the
 * answer. A setup that names a profile (an Advanced pick, a remembered pin)
 * keeps it. `chatDefault` answering nothing means the family's selected
 * profile has no chat form of its own because it IS a chat-capable agent
 * already (a plugin's adapter, `chatDefaultFor`): the launch then names no
 * profile and main runs that selected profile as it is.
 */
export function transportProfileFor(
  setup: AgentSetup | null,
  chatDefault: (family: 'claude' | 'codex') => string | undefined
): string | undefined {
  if (!setup) return undefined
  if (setup.launchProfileId) return setup.launchProfileId
  if (setup.kind === 'claude-agents') return undefined
  const harness = HARNESS_BY_ID[setup.kind]
  if (!harness.chatAdapterId) return undefined
  if (useLaunchSettingsStore.getState().interactionMode === 'terminal') return undefined
  if (setup.kind === 'claude' && window.electronAPI?.platform === 'win32') return undefined
  return chatDefault(setup.kind as 'claude' | 'codex')
}

const NO_AGENT = {
  claudeMode: false,
  claudeAgentsMode: false,
  antigravityMode: false,
  codexMode: false,
  piMode: false
}

/** What a setup names in a SERVER's own lists (PRDCT-4162): the profile's
 *  definition and the account, read from the settings this Mac keeps of the
 *  server. The launcher builds a server's rows from those lists
 *  (`lib/launch-source.ts`), and every launch that lands on a server resolves
 *  the same way, whichever button or shortcut replayed the setup: a profile
 *  the server lists is sent with its definition (which also stops the
 *  preload substituting a Mac profile of the same id), an account the server
 *  lists is sent by its id and label. A profile the server does not list
 *  keeps the carried path of #241 (a Mac profile travels with its command);
 *  an account the server does not list never travels, as before. A server
 *  whose settings this Mac has not read yet is read first, so a setup
 *  replayed right after boot sends the account it names (verifier, round 2);
 *  a read that fails leaves the built-ins alone. */
async function serverPick(
  serverId: string,
  setup: AgentSetup
): Promise<{
  profile?: LaunchProfile
  claudeAccount?: { id: string; label: string }
  codexAccount?: { id: string; label: string }
}> {
  const settings = (await serverSettingsReady(serverId)) ?? {
    profiles: null,
    claude: [],
    codex: []
  }
  const family: LauncherFamily = setup.kind === 'claude-agents' ? 'claude' : setup.kind
  const profile = setup.launchProfileId
    ? serverProfilesFor(settings, family).find((p) => p.id === setup.launchProfileId)
    : undefined
  const claude =
    family === 'claude' && setup.claudeProfileId
      ? settings.claude.find((a) => a.id === setup.claudeProfileId)
      : undefined
  const codex =
    family === 'codex' && setup.codexAccountId
      ? settings.codex.find((a) => a.id === setup.codexAccountId)
      : undefined
  return {
    ...(profile ? { profile } : {}),
    ...(claude ? { claudeAccount: { id: claude.id, label: claude.label } } : {}),
    ...(codex ? { codexAccount: { id: codex.id, label: codex.label } } : {})
  }
}

/** A launch on a connected Clave server, in the normal flow (#241): the
 *  launcher's setup travels, the cwd is the server workspace's root (or a
 *  folder picked on the server's disk), and the server runs it on its own
 *  executables and subscriptions, the profile and the account resolved
 *  against the server's own lists (`serverPick`). An offline server refuses
 *  with a notice. */
async function launchOnServer(serverId: string, req: LaunchRequest): Promise<string | null> {
  const fleet = useFleetStore.getState()
  const serverName = fleet.connections.find((c) => c.id === serverId)?.name ?? 'The server'
  const refuse = (message: string, cause?: unknown): null => {
    showLaunchNotice(message)
    if (req.throwOnError) throw cause ?? new Error(message)
    return null
  }
  if (fleet.statuses[serverId]?.state !== 'connected')
    return refuse(`${serverName} is offline. Its sessions start again once it reconnects.`)

  const workspaceId = req.workspaceId ?? getActiveWorkspaceId()
  const workspace =
    workspaceServer(workspaceId) === serverId ? getWorkspaceById(workspaceId) : undefined
  const cwd =
    req.cwd.kind === 'path'
      ? req.cwd.path
      : req.cwd.kind === 'workspace-root' && workspace
        ? workspace.rootDir
        : await pickServerFolder({ serverId, serverName, startPath: workspace?.rootDir })
  if (!cwd) return null

  const modes = req.setup ? agentSetupToModes(req.setup) : NO_AGENT
  const dangerousMode = req.setup?.dangerousMode ?? false
  const initialPrompt =
    req.initialPrompt && agentAcceptsPrompt(req.setup) ? req.initialPrompt : undefined
  // The transport from the mode, against the server's own profiles: its chat
  // default in chat form when the person launches in a chat view.
  const serverSettings = await serverSettingsReady(serverId)
  // A server whose profiles are not known yet gets its built-in chat.
  const launchProfileId = transportProfileFor(req.setup, (family) =>
    serverSettings?.profiles
      ? chatDefaultFor(serverSettings.profiles, family, null)
      : CHAT_PROFILE_IDS[family]
  )
  const setup = req.setup && launchProfileId ? { ...req.setup, launchProfileId } : req.setup
  const pick = setup ? await serverPick(serverId, setup) : {}
  const serverProfile = pick.profile
  const claudeAccount = modes.claudeMode || modes.claudeAgentsMode ? pick.claudeAccount : undefined
  const codexAccount = modes.codexMode ? pick.codexAccount : undefined
  let id: string
  try {
    const info = await window.electronAPI.fleetStart(serverId, cwd, {
      ...modes,
      dangerousMode,
      ...setupSpawnFlags(req.setup, launchProfileId, workspaceId),
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(launchProfileId ? { launchProfileId } : {}),
      ...(serverProfile ? { launchProfile: serverProfile } : {}),
      ...(claudeAccount
        ? { claudeProfileId: claudeAccount.id, claudeProfileLabel: claudeAccount.label }
        : {}),
      ...(codexAccount
        ? { codexAccountId: codexAccount.id, codexAccountLabel: codexAccount.label }
        : {}),
      ...(workspace ? { workspaceId: workspace.id } : {})
    })
    id = info.id
  } catch (err) {
    console.error('Failed to start a session on the server:', err)
    return refuse(`${serverName} could not start the session in ${cwd}.`, err)
  }
  req.onCreated?.(id)
  try {
    // The tab arrives with the server's next snapshot; read it now so it is
    // placed and focused at once rather than on the next push.
    await window.electronAPI.fleetSnapshot(serverId)
  } catch {
    /* the push brings it */
  }
  const store = useSessionStore.getState()
  if (req.groupId && ownerOf(req.groupId) === serverId) store.moveItems([id], req.groupId, 'inside')
  useSessionStore.setState({
    selectedSessionIds: [id],
    focusedSessionId: id,
    activeView: 'terminals'
  })
  if (req.remember && req.setup) rememberAgentSetup(getActiveWorkspaceId(), req.setup)
  return id
}

/** The single session launch path.
 *
 *  Both callers used to carry their own copy of this — `handleNewSession` in
 *  Sidebar and `spawnSessionWithOptions` in AppShell — which is how they drifted
 *  into each always opening a folder dialog. One path means the cwd rule, the
 *  profile rule, and the remembered setup are decided in exactly one place.
 *
 *  Returns the new session id, or null when the launch was cancelled or failed. */
export async function launchSession(req: LaunchRequest): Promise<string | null> {
  const id = await launchSessionNow(req)
  // A chat style picked in the first-run walk and not yet known to the
  // process that opens sessions rides on the first chat (pending-chat-view.ts).
  if (id && req.setup && pendingChatView()) {
    await deliverPendingChatView(id, window.electronAPI).catch(() => false)
  }
  return id
}

async function launchSessionNow(req: LaunchRequest): Promise<string | null> {
  clearLaunchNotice()
  const serverId = launchServer(req)
  if (serverId !== LOCAL_SERVER_ID) return launchOnServer(serverId, req)
  const folderPath = await resolveCwd(req.cwd)
  if (!folderPath) return null

  const modes = req.setup ? agentSetupToModes(req.setup) : NO_AGENT
  const dangerousMode = req.setup?.dangerousMode ?? false

  // The Claude account applies to Claude Code and Claude Agents only — never a
  // plain terminal, Antigravity, or Codex. The Default profile contributes no
  // configDir, so those sessions stay a passthrough.
  //
  //  A setup with no explicit account means "the selected one", not "the Default
  //  one": both old launch paths resolved it that way (the sidebar through
  //  `claudeProfileId ?? selectedProfileId`, the keybindings through
  //  `getSelectedClaudeProfile()`), and `getClaudeProfile(undefined)` falls back
  //  to profiles[0] — the Default — which would silently run keyboard launches
  //  under the wrong account.
  const initialPrompt =
    req.initialPrompt && agentAcceptsPrompt(req.setup) ? req.initialPrompt : undefined

  // The account is the pool's answer (ADR 0002): the one asked for while it
  // has headroom, else the next one along. Claude and Codex alike, each
  // judged for the model the launch will run (PRDCT-4302): a chat starts on
  // the model last picked in its composer, so an account with its Fable week
  // spent still takes a launch on Opus. A model picked in the launcher
  // (PRDCT-4423) is the one the launch runs, so it is the one judged.
  const isClaudeSession = modes.claudeMode || modes.claudeAgentsMode
  const launchWorkspaceId = req.workspaceId ?? getActiveWorkspaceId()
  const pickedModel = req.setup?.model
  const launchProfileId = transportProfileFor(req.setup, (family) =>
    selectedChatProfile(family, launchWorkspaceId)
  )
  const [claudeModel, codexModel] = await Promise.all([
    isClaudeSession
      ? (pickedModel ?? rememberedLaunchModel('claude', launchProfileId, launchWorkspaceId))
      : undefined,
    modes.codexMode
      ? (pickedModel ?? rememberedLaunchModel('codex', launchProfileId, launchWorkspaceId))
      : undefined
  ])
  const profile = isClaudeSession
    ? accountForLaunch('claude', req.setup?.claudeProfileId, claudeModel)
    : null
  const codexAccount = modes.codexMode
    ? accountForLaunch('codex', req.setup?.codexAccountId, codexModel)
    : null
  if (
    req.exactProfile &&
    ((profile && profile.id !== req.setup?.claudeProfileId) ||
      (codexAccount && codexAccount.id !== req.setup?.codexAccountId))
  ) {
    throw Object.assign(new Error('The selected account is no longer available.'), {
      code: 'launch-account-unavailable' as const,
      cleanupSucceeded: true
    }) satisfies LaunchSelectionError
  }
  const profileFields = {
    ...(profile ? claudeProfileSpawnFields(profile) : {}),
    ...(codexAccount ? codexAccountSpawnFields(codexAccount) : {})
  }

  const previousIds = req.exactProfile
    ? new Set((await window.electronAPI.sessionsList()).map((session) => session.id))
    : null

  try {
    const sessionInfo = await window.electronAPI.spawnSession(folderPath, {
      ...modes,
      dangerousMode,
      initialPrompt,
      launchProfileId,
      ...setupSpawnFlags(req.setup, launchProfileId, launchWorkspaceId),
      ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
      ...profileFields
    })
    if (req.exactProfile && sessionInfo.launchProfileId !== launchProfileId) {
      let cleanupSucceeded = false
      try {
        const created = (await window.electronAPI.sessionsList()).find(
          (s) => s.id === sessionInfo.id
        )
        // A terminal is prepared without a process until its pane sends a
        // size. We have not placed this handle, and it was absent before our
        // request. Never clean up an existing tab or an events provider here.
        if (
          !previousIds!.has(sessionInfo.id) &&
          created?.transport === 'pty' &&
          created.state === 'idle' &&
          !useSessionStore.getState().sessions.some((s) => s.id === sessionInfo.id)
        ) {
          await window.electronAPI.killSession(sessionInfo.id)
          cleanupSucceeded = !(await window.electronAPI.sessionsList()).some(
            (s) => s.id === sessionInfo.id
          )
        }
      } catch {
        /* Keep an uncertain handle; never retry or touch another session. */
      }
      if (!cleanupSucceeded && !previousIds!.has(sessionInfo.id)) req.onCreated?.(sessionInfo.id)
      throw Object.assign(new Error('The selected launch profile changed before startup.'), {
        code: 'launch-profile-mismatch' as const,
        cleanupSucceeded
      }) satisfies LaunchSelectionError
    }
    req.onCreated?.(sessionInfo.id)
    // One placement, not a placement and then a correction: the group's `+`
    // has already said where this goes, so it goes there — as the group's
    // first row, the same "newest at the top" the sidebar itself follows.
    useSessionStore.getState().addSessionInGroup(
      {
        id: sessionInfo.id,
        cwd: sessionInfo.cwd,
        folderName: sessionInfo.folderName,
        name: sessionInfo.folderName,
        alive: sessionInfo.alive,
        activityStatus: 'idle',
        promptWaiting: null,
        ...modes,
        dangerousMode,
        claudeSessionId: sessionInfo.claudeSessionId,
        piSessionId: sessionInfo.piSessionId,
        launchProfileId: sessionInfo.launchProfileId,
        model: sessionInfo.model,
        piProvider: sessionInfo.piProvider,
        piThinking: sessionInfo.piThinking,
        claudeProfileId: profile?.id,
        claudeProfileLabel: profile?.label,
        codexAccountId: codexAccount?.id,
        codexAccountLabel: codexAccount?.label,
        // Persisted so Duplicate re-primes the clone with the same prompt.
        initialPrompt,
        sessionType: 'local',
        ...(req.workspaceId ? { workspaceId: req.workspaceId } : {})
      },
      req.groupId ?? null
    )
    // Remembered only after a launch actually succeeded: a cancelled picker or
    // a failed spawn must not redefine what the agent button does next.
    if (req.remember && req.setup) rememberAgentSetup(getActiveWorkspaceId(), req.setup)
    return sessionInfo.id
  } catch (err) {
    if (req.throwOnError) throw err
    console.error('Failed to create session:', err)
    return null
  }
}
