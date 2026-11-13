import {
  chatProfileSource,
  resolveLaunchProfile,
  type LaunchProfilePreferences,
  type LauncherFamily
} from './agent-launch'
import type { InteractionMode } from './harness'

/** The modes `clave_open_session` takes; 'gemini' is the retired CLI's name,
 *  kept as an alias for antigravity. */
export type OpenSessionMode =
  | 'claude'
  | 'antigravity'
  | 'gemini'
  | 'codex'
  | 'pi'
  | 'opencode'
  | 'terminal'

export interface SpawnModes {
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
  piMode: boolean
  opencodeMode: boolean
  /** Start the agent without approval prompts. The spawn turns it into
   *  claude's --dangerously-skip-permissions and codex's --yolo. */
  dangerousMode: boolean
  model: string | undefined
  /** The launch-profile family the mode runs on; null for a plain terminal. */
  family: LauncherFamily | null
}

/** The agents whose CLI takes a skip-approvals flag, the ones the spawn path
 *  knows (`buildAgentArgv`): claude, codex and opencode (`--auto`).
 *  Antigravity has none, and pi's CLI takes no equivalent, so the flag is dropped for them here rather
 *  than carried to a spawn that would ignore it. Until PRDCT-2528 the flag was
 *  kept for claude alone, so an agent asking for a Codex lane in YOLO mode got
 *  a tab that asked for approval on every command, while the launcher's own
 *  Cmd+Y reached the same spawn with the flag intact. */
export const DANGEROUS_MODE_FAMILIES: ReadonlySet<LauncherFamily> = new Set([
  'claude',
  'codex',
  'opencode'
])

/** Which CLI a `clave_open_session` call starts and which flags it takes,
 *  decided in one place the dispatcher calls and a unit test can reach. */
export function resolveSpawnModes(payload: {
  mode?: OpenSessionMode
  dangerous?: boolean
  model?: string
}): SpawnModes {
  const mode = payload.mode ?? 'claude'
  const claudeMode = mode === 'claude'
  const antigravityMode = mode === 'antigravity' || mode === 'gemini'
  const codexMode = mode === 'codex'
  const piMode = mode === 'pi'
  const opencodeMode = mode === 'opencode'
  const family: LauncherFamily | null =
    mode === 'gemini' ? 'antigravity' : mode === 'terminal' ? null : mode
  const dangerousMode =
    family !== null && DANGEROUS_MODE_FAMILIES.has(family) && payload.dangerous === true
  // model maps to claude --model / codex -m / pi --model, and to OpenCode's
  // configuration (`OPENCODE_CONFIG_CONTENT`, `providerInjection`), which its
  // TUI and its chat read in its `provider/model` form (PRDCT-4496); antigravity
  // and terminals have none.
  const model =
    (claudeMode || codexMode || piMode || opencodeMode) && payload.model ? payload.model : undefined
  return {
    claudeMode,
    antigravityMode,
    codexMode,
    piMode,
    opencodeMode,
    dangerousMode,
    model,
    family
  }
}

/** The built-in launch profile that runs each family in Clave's chat view
 *  (src/main/launch-profile-manager.ts, CHAT_PROFILES). */
export const CHAT_PROFILE_IDS: Partial<Record<OpenSessionMode, string>> = {
  claude: 'claude-chat',
  codex: 'codex-chat',
  // Lane D (PRDCT-4427): OpenCode's chat, over the Agent Client Protocol.
  opencode: 'opencode-chat',
  // Lane D (PRDCT-4427): Pi's chat, over Pi's own rpc mode.
  pi: 'pi-chat'
}

/** The families with a chat view, the ones `CHAT_PROFILE_IDS` names: Claude,
 *  Codex, OpenCode and Pi (lane D, PRDCT-4427). */
type ChatFamily = 'claude' | 'codex' | 'opencode' | 'pi'
const chatFamilyOf = (family: LauncherFamily): ChatFamily | undefined =>
  family === 'claude' || family === 'codex' || family === 'opencode' || family === 'pi'
    ? family
    : undefined

/** Is this id a chat profile of the family: its built-in chat profile, or the
 *  chat form of one of its saved profiles (`chat:<family>:<id>`, the id the
 *  launcher's "(chat)" entries and the settings' chat defaults carry)? Ids
 *  only: the chat rule never reads a name. */
export function isChatProfileRef(family: LauncherFamily, id: string): boolean {
  return id === CHAT_PROFILE_IDS[family] || chatProfileSource(id)?.family === family
}

/**
 * The chat profile the launcher would open a family's chat on in a workspace,
 * from the preferences as the host lists them (`launchProfilesList`, the chat
 * forms of the saved profiles included): the family's default for the
 * workspace, else the global one, else the built-in. Itself when it is a chat
 * profile; its chat form when it is a saved terminal profile, the "(chat)"
 * entry the launcher offers beside it (one saved definition, two forms, so a
 * profile that skips approvals in a terminal skips them in a chat); the
 * built-in chat when it is the built-in terminal. Undefined for a default with
 * no chat form (a plugin's agent) and for a family with no chat view, and
 * `resolveProfileRef` then answers the built-in chat.
 */
export function chatDefaultFor(
  preferences: LaunchProfilePreferences,
  family: LauncherFamily,
  workspaceId: string | null | undefined
): string | undefined {
  const chatFamily = chatFamilyOf(family)
  if (!chatFamily) return undefined
  // A preferences object off the wire may lack a table; the resolver indexes them.
  const prefs: LaunchProfilePreferences = {
    version: 1,
    customProfiles: preferences.customProfiles ?? [],
    globalDefaults: preferences.globalDefaults ?? {},
    workspaceOverrides: preferences.workspaceOverrides ?? {}
  }
  const selected = resolveLaunchProfile(prefs, chatFamily, workspaceId)
  if (isChatProfileRef(chatFamily, selected.id)) return selected.id
  if (selected.builtIn) return CHAT_PROFILE_IDS[chatFamily]
  return prefs.customProfiles.find(
    (profile) =>
      profile.family === chatFamily &&
      profile.sourceProfileId === selected.id &&
      chatProfileSource(profile.id)?.family === chatFamily
  )?.id
}

/**
 * Whether a `clave_open_session` call opens a chat view: its own `chat` when
 * it says, else (no `profile` named either) what the person's launcher does,
 * their interaction mode (PRDCT-4425): a chat view for a family that has one
 * unless the mode is `terminal`. Undefined when nothing decides it: a named
 * profile decides for itself, and a family with no chat view opens its
 * terminal profile.
 */
export function chatOfInteractionMode(
  payload: { mode?: OpenSessionMode; chat?: boolean; profile?: string },
  interactionMode: InteractionMode
): boolean | undefined {
  if (payload.chat !== undefined) return payload.chat
  if (payload.profile) return undefined
  if (!CHAT_PROFILE_IDS[payload.mode ?? 'claude']) return undefined
  return interactionMode !== 'terminal'
}

/**
 * The launch profile a `clave_open_session` call names, with `chat: true`
 * turned into a chat profile of the family. The chat view IS a launch profile,
 * so before `chat` existed an agent could only reach it by knowing the
 * profile's id — the tool never said so, and agents told the user it could
 * not be done. `chatDefault` is the chat the launcher would open for the
 * family in the target workspace (`chatDefaultFor`): an agent's chat lands on
 * the same tab the person gets from the launcher. Until 3 November 2026 the
 * flag always answered the built-in chat profile, so a workspace whose Codex
 * chats ran on a profile of the person's own got, from an agent, a tab on the
 * built-in command and its default approval policy, and asked before every
 * command. An explicit chat profile still wins. Refuses what cannot be
 * honoured rather than quietly opening a terminal: chat on a mode that has no
 * chat view, or chat beside a profile that is not a chat profile.
 *
 * Until 11 November 2026 an omitted `chat` meant the terminal, so an agent
 * that did not say opened a terminal tab for a person whose launcher opens
 * chats (PRDCT-4175, PRDCT-4425). An omitted `chat` with no `profile` now
 * follows `interactionMode`, the person's launcher: the chat default for a
 * family with a chat view unless the mode is `terminal`, the family's
 * selected terminal profile (undefined) otherwise. `chat: true` and
 * `chat: false` keep their meaning, and an explicit `profile` is honoured as
 * is. A caller that passes no mode keeps the old meaning (`terminal`):
 * `mcp-server.ts` turns an omitted `chat` into an explicit one from the
 * person's mode before any road (`chatOfInteractionMode`), so the window
 * road, the fleet road and the served tools only see an omitted `chat` where
 * the mode decides nothing (a named profile, a family with no chat view) or
 * where a chat cannot open (Claude on Windows).
 */
export function resolveProfileRef(
  payload: { mode?: OpenSessionMode; chat?: boolean; profile?: string },
  chatDefault?: string,
  interactionMode: InteractionMode = 'terminal'
): string | undefined {
  const mode = payload.mode ?? 'claude'
  const chatProfile = CHAT_PROFILE_IDS[mode]
  if (payload.chat === undefined && !payload.profile) {
    if (!chatProfile || interactionMode === 'terminal') return undefined
    return chatDefault !== undefined && isChatProfileRef(mode as ChatFamily, chatDefault)
      ? chatDefault
      : chatProfile
  }
  if (!payload.chat) return payload.profile
  if (!chatProfile) {
    // The families named from the table itself (lane D, PRDCT-4427), so the
    // sentence follows every chat view added to it.
    const families = Object.keys(CHAT_PROFILE_IDS)
      .map((family) => `"${family}"`)
      .join(', ')
    throw new Error(`chat: true needs mode ${families}; "${mode}" has no chat view`)
  }
  const family = mode as ChatFamily
  if (payload.profile) {
    if (!isChatProfileRef(family, payload.profile))
      throw new Error(
        `chat: true opens a chat profile ("${chatProfile}", or a "chat:${family}:…" one); drop profile "${payload.profile}" or chat`
      )
    return payload.profile
  }
  return chatDefault !== undefined && isChatProfileRef(family, chatDefault)
    ? chatDefault
    : chatProfile
}
