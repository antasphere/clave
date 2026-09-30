import { useSessionStore } from '../store/session-store'
import { claudeProfileSpawnFields } from '../store/claude-profile-store'
import { codexAccountSpawnFields } from '../store/codex-account-store'
import { accountForLaunch } from './switch-account'
import { getActiveWorkspaceId, getWorkspaceById } from '../store/workspace-store'
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

/** The single local-session launch path.
 *
 *  Both callers used to carry their own copy of this — `handleNewSession` in
 *  Sidebar and `spawnSessionWithOptions` in AppShell — which is how they drifted
 *  into each always opening a folder dialog. One path means the cwd rule, the
 *  profile rule, and the remembered setup are decided in exactly one place.
 *
 *  Returns the new session id, or null when the launch was cancelled or failed. */
export async function launchSession(req: LaunchRequest): Promise<string | null> {
  const folderPath = await resolveCwd(req.cwd)
  if (!folderPath) return null

  const modes = req.setup
    ? agentSetupToModes(req.setup)
    : {
        claudeMode: false,
        claudeAgentsMode: false,
        antigravityMode: false,
        codexMode: false,
        piMode: false
      }
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
  // has headroom, else the next one along. Claude and Codex alike.
  const isClaudeSession = modes.claudeMode || modes.claudeAgentsMode
  const profile = isClaudeSession ? accountForLaunch('claude', req.setup?.claudeProfileId) : null
  const codexAccount = modes.codexMode ? accountForLaunch('codex', req.setup?.codexAccountId) : null
  const profileFields = {
    ...(profile ? claudeProfileSpawnFields(profile) : {}),
    ...(codexAccount ? codexAccountSpawnFields(codexAccount) : {})
  }

  try {
    const sessionInfo = await window.electronAPI.spawnSession(folderPath, {
      ...modes,
      dangerousMode,
      initialPrompt,
      launchProfileId: req.setup?.launchProfileId,
      ...profileFields
    })
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
        sessionType: 'local'
      },
      req.groupId ?? null
    )
    // Remembered only after a launch actually succeeded: a cancelled picker or
    // a failed spawn must not redefine what the agent button does next.
    if (req.remember && req.setup) rememberAgentSetup(getActiveWorkspaceId(), req.setup)
    return sessionInfo.id
  } catch (err) {
    console.error('Failed to create session:', err)
    return null
  }
}
