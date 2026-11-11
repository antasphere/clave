/**
 * A routine's launch parameters resolved to a spawn (ADR 0004), through the
 * very functions `clave_open_session` resolves a tab with and not a copy of
 * them: `resolveSpawnModes` for the agent, the model and the skip flag;
 * `resolveProfileRef` with the workspace's chat default for the form and
 * the profile; the served account resolution for the account. A missing
 * field falls back to the workspace's launch default; an invalid one fails
 * the run with the reason, never a silent fallback.
 *
 * Pure over the facts a process states (`LaunchFacts`), so the rules have
 * tests of their own and both entries (Electron main, the standalone
 * server) feed it from what they have.
 */
import type { RoutineAgent, RoutineDeclaration, RoutineForm } from '@clave/contract/routines'
import type { SpawnOptions } from '@clave/contract/sessions'
import {
  BUILT_IN_LAUNCH_PROFILES,
  type LaunchProfilePreferences,
  type LauncherFamily,
  type PiThinkingLevel
} from '../../shared/agent-launch'
import { isValidEffort } from '../../shared/effort'
import {
  CHAT_PROFILE_IDS,
  DANGEROUS_MODE_FAMILIES,
  chatDefaultFor,
  isChatProfileRef,
  resolveProfileRef,
  resolveSpawnModes
} from '../../shared/open-session-modes'
import { type AccountFacts, resolveAccountRef, spawnFieldsOf } from '../mcp/served-accounts'

const AGENTS: ReadonlySet<string> = new Set<RoutineAgent>(['claude', 'codex', 'pi', 'antigravity'])
const FORMS: ReadonlySet<string> = new Set<RoutineForm>(['chat', 'terminal'])
const THINKING: ReadonlySet<string> = new Set<PiThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

export interface LaunchFacts extends AccountFacts {
  /** The launch profile preferences this server runs on (the chat default and the custom profiles). */
  preferences(): LaunchProfilePreferences
  /** The model a launch naming none will run once spawned (main's
   *  `rememberedSpawnModel`), which its account is judged by (PRDCT-4253);
   *  absent or undefined when the process cannot know it. */
  launchModel?(
    family: 'claude' | 'codex',
    launchProfileId: string | undefined,
    workspaceId: string | undefined
  ): string | undefined
}

export type ResolvedLaunch =
  | {
      ok: true
      agent: RoutineAgent
      form: RoutineForm
      /** What the spawn is told, every field the parameters decided. */
      spawn: SpawnOptions
      model: string | null
      account: string | null
    }
  | { ok: false; reason: string }

/** The agents whose session can call Clave's MCP tools, and so report. */
export const REPORTING_AGENTS: ReadonlySet<RoutineAgent> = new Set<RoutineAgent>([
  'claude',
  'codex'
])

export function resolveLaunch(
  routine: Pick<RoutineDeclaration, 'launch' | 'workspaceId' | 'name'>,
  facts: LaunchFacts
): ResolvedLaunch {
  const p = routine.launch
  const fail = (reason: string): ResolvedLaunch => ({ ok: false, reason })

  const agent = (p.agent ?? 'claude') as RoutineAgent
  if (!AGENTS.has(agent))
    return fail(`agent "${String(p.agent)}" is not one of claude, codex, pi, antigravity`)
  // The chat is the form a run is watched in (its blocked and done states);
  // an agent with no chat view runs in a terminal.
  const form = (p.form ?? (CHAT_PROFILE_IDS[agent] ? 'chat' : 'terminal')) as RoutineForm
  if (!FORMS.has(form)) return fail(`form "${String(p.form)}" is not chat or terminal`)
  if (form === 'chat' && !CHAT_PROFILE_IDS[agent])
    return fail(`form "chat" needs agent claude or codex; ${agent} has no chat view`)

  if (p.dangerousMode === true && !DANGEROUS_MODE_FAMILIES.has(agent as LauncherFamily))
    return fail(`dangerousMode is for claude and codex; ${agent} has no such flag`)
  if (p.permissionMode !== undefined && agent !== 'claude')
    return fail(`permissionMode is for claude; ${agent} takes none`)
  if (p.effort !== undefined && agent !== 'claude')
    return fail(`effort is for claude; ${agent} takes none here`)
  if (p.effort !== undefined && !isValidEffort(p.effort))
    return fail(`effort "${p.effort}" is not a level Claude knows`)
  if (p.thinking !== undefined && agent !== 'pi')
    return fail(`thinking is for pi; ${agent} takes none`)
  if (p.thinking !== undefined && !THINKING.has(p.thinking))
    return fail(
      `thinking "${p.thinking}" is not one of off, minimal, low, medium, high, xhigh, max`
    )
  if (p.provider !== undefined && agent !== 'pi')
    return fail(`provider is for pi; ${agent} takes none`)
  if (p.model !== undefined && agent === 'antigravity') return fail('antigravity takes no model')
  if (p.account !== undefined && agent !== 'claude' && agent !== 'codex')
    return fail(`account is for claude and codex; ${agent} has no account pool`)

  const modes = resolveSpawnModes({
    mode: agent,
    ...(p.dangerousMode !== undefined ? { dangerous: p.dangerousMode } : {}),
    ...(p.model !== undefined ? { model: p.model } : {})
  })
  const family = modes.family as LauncherFamily

  // The profile: by id or by name among the family's, the built-ins first;
  // a chat run takes the profile's chat form, or the workspace's chat default.
  const preferences = facts.preferences()
  const profiles = [...BUILT_IN_LAUNCH_PROFILES, ...preferences.customProfiles].filter(
    (profile) => profile.family === family
  )
  let profileRef: string | undefined
  if (p.profile !== undefined) {
    if (form === 'chat' && isChatProfileRef(family, p.profile)) profileRef = p.profile
    else {
      const found =
        profiles.find((x) => x.id === p.profile) ??
        profiles.find((x) => x.name.toLowerCase() === p.profile!.toLowerCase())
      if (!found)
        return fail(
          `launch profile "${p.profile}" is not a ${family} profile here (${profiles.map((x) => `"${x.name}"`).join(', ')})`
        )
      profileRef =
        form === 'chat'
          ? found.builtIn
            ? CHAT_PROFILE_IDS[agent]
            : `chat:${family}:${found.id}`
          : found.id
    }
  }
  let launchProfileId: string | undefined
  try {
    launchProfileId = resolveProfileRef(
      {
        mode: agent,
        chat: form === 'chat',
        ...(profileRef !== undefined ? { profile: profileRef } : {})
      },
      // A routine's explicit profile is an operator choice, including the
      // built-in. Only an omitted profile inherits the workspace default.
      form === 'chat' && p.profile === undefined
        ? chatDefaultFor(preferences, family, routine.workspaceId)
        : undefined
    )
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }

  // The account (ADR 0002): claude and codex only, the pool's pick for `any` or nothing.
  let accountFields: SpawnOptions = {}
  let account: string | null = null
  if (agent === 'claude' || agent === 'codex') {
    try {
      // A routine naming no model runs the one main remembers for its chat:
      // the account is judged for that one, never on the shared caps alone.
      const model = modes.model ?? facts.launchModel?.(agent, launchProfileId, routine.workspaceId)
      const resolved = resolveAccountRef(facts, agent, p.account, model)
      accountFields = spawnFieldsOf(agent, resolved)
      account = resolved.label
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    ok: true,
    agent,
    form,
    model: modes.model ?? null,
    account,
    spawn: {
      claudeMode: modes.claudeMode,
      antigravityMode: modes.antigravityMode,
      codexMode: modes.codexMode,
      piMode: modes.piMode,
      dangerousMode: modes.dangerousMode,
      ...(modes.model !== undefined ? { model: modes.model } : {}),
      ...(launchProfileId !== undefined ? { launchProfileId } : {}),
      ...accountFields,
      ...(p.effort !== undefined ? { effort: p.effort } : {}),
      ...(p.permissionMode !== undefined && !modes.dangerousMode
        ? { permissionMode: p.permissionMode }
        : {}),
      ...(agent === 'pi' && p.provider !== undefined ? { piProvider: p.provider } : {}),
      ...(agent === 'pi' && p.thinking !== undefined ? { piThinking: p.thinking } : {})
    }
  }
}
