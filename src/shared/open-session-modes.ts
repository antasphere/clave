import type { LauncherFamily } from './agent-launch'

/** The modes `clave_open_session` takes; 'gemini' is the retired CLI's name,
 *  kept as an alias for antigravity. */
export type OpenSessionMode = 'claude' | 'antigravity' | 'gemini' | 'codex' | 'pi' | 'terminal'

export interface SpawnModes {
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
  piMode: boolean
  /** Start the agent without approval prompts. The spawn turns it into
   *  claude's --dangerously-skip-permissions and codex's --yolo. */
  dangerousMode: boolean
  model: string | undefined
  /** The launch-profile family the mode runs on; null for a plain terminal. */
  family: LauncherFamily | null
}

/** The agents whose CLI takes a skip-approvals flag, the same two the spawn
 *  path knows (`buildAgentArgv`): claude and codex. Antigravity has none, and
 *  pi's CLI takes no equivalent, so the flag is dropped for them here rather
 *  than carried to a spawn that would ignore it. Until PRDCT-2528 the flag was
 *  kept for claude alone, so an agent asking for a Codex lane in YOLO mode got
 *  a tab that asked for approval on every command, while the launcher's own
 *  Cmd+Y reached the same spawn with the flag intact. */
export const DANGEROUS_MODE_FAMILIES: ReadonlySet<LauncherFamily> = new Set(['claude', 'codex'])

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
  const family: LauncherFamily | null =
    mode === 'gemini' ? 'antigravity' : mode === 'terminal' ? null : mode
  const dangerousMode =
    family !== null && DANGEROUS_MODE_FAMILIES.has(family) && payload.dangerous === true
  // model maps to claude --model / codex -m / pi --model; antigravity and
  // terminals have no flag.
  const model = (claudeMode || codexMode || piMode) && payload.model ? payload.model : undefined
  return { claudeMode, antigravityMode, codexMode, piMode, dangerousMode, model, family }
}

/** The built-in launch profile that runs each family in Clave's chat view
 *  (src/main/launch-profile-manager.ts, CHAT_PROFILES). */
export const CHAT_PROFILE_IDS: Partial<Record<OpenSessionMode, string>> = {
  claude: 'claude-chat',
  codex: 'codex-chat'
}

/**
 * The launch profile a `clave_open_session` call names, with `chat: true`
 * turned into the family's chat profile. The chat view IS a launch profile,
 * so before `chat` existed an agent could only reach it by knowing the
 * profile's id — the tool never said so, and agents told the user it could
 * not be done. Refuses what cannot be honoured rather than quietly opening a
 * terminal: chat on a mode that has no chat view, or chat beside a profile
 * that is not that chat profile.
 */
export function resolveProfileRef(payload: {
  mode?: OpenSessionMode
  chat?: boolean
  profile?: string
}): string | undefined {
  if (!payload.chat) return payload.profile
  const mode = payload.mode ?? 'claude'
  const chatProfile = CHAT_PROFILE_IDS[mode]
  if (!chatProfile) {
    throw new Error(`chat: true needs mode "claude" or "codex"; "${mode}" has no chat view`)
  }
  if (payload.profile && payload.profile !== chatProfile) {
    throw new Error(
      `chat: true opens the "${chatProfile}" profile; drop profile "${payload.profile}" or chat`
    )
  }
  return chatProfile
}
