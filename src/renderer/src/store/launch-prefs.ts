import { create } from 'zustand'
import { useAccountPolicyStore } from './account-policy-store'
import { isValidModelName } from '../../../shared/model-name'
import { chatProfileSource } from '../../../shared/agent-launch'
import { CHAT_PROFILE_IDS } from '../../../shared/open-session-modes'

/** Which agent a session runs. One field instead of the four booleans
 *  (`claudeMode` / `claudeAgentsMode` / `antigravityMode` / `codexMode`) the
 *  launch paths thread today: a session is always exactly one of these, and
 *  four independent booleans can encode states that don't exist. The booleans
 *  stay the wire format for `spawnSession` and the Session record — this type
 *  is the launcher's own vocabulary, bridged by the helpers below. */
export type AgentKind = 'claude' | 'claude-agents' | 'antigravity' | 'codex' | 'pi' | 'opencode'

/** Everything the agent button needs to relaunch what was last launched. */
export interface AgentSetup {
  kind: AgentKind
  dangerousMode: boolean
  /** Claude account. Applies to `claude` and `claude-agents` only — the other
   *  kinds ignore it, matching the spawn paths. */
  claudeProfileId?: string
  /** Codex account (ADR 0002). Applies to `codex` only. */
  codexAccountId?: string
  /** Local binary-wrapper profile, independent from the Claude account. */
  launchProfileId?: string
  /** The model picked in the launcher (PRDCT-4423): what the pool judges
   *  the account by and what the spawn passes as the CLI's model flag.
   *  Absent = the harness's own default. */
  model?: string
  /** The stored provider connection a Pi or OpenCode launch runs on, and its
   *  name (PRDCT-4496); never its key. Absent = the harness's own login. */
  connectionId?: string
  connectionLabel?: string
}

export const DEFAULT_AGENT_SETUP: AgentSetup = { kind: 'claude', dangerousMode: false }

/** Bucket for the last setup in no-workspace mode (`activeWorkspaceId` is null
 *  exactly when no workspace is registered). A real uuid can never collide. */
const NO_WORKSPACE_KEY = '__none__'

/** Preferences key. Lives in the main-process preference file rather than
 *  localStorage: Chromium flushes localStorage lazily, so a crash can lose the
 *  last write — and losing this one silently sends the next launch to the
 *  wrong agent. */
const PREF_KEY = 'lastAgentSetupByWorkspace'

const AGENT_KINDS: readonly AgentKind[] = [
  'claude',
  'claude-agents',
  'antigravity',
  'codex',
  'pi',
  'opencode'
]

/** The four spawn booleans for a setup. Exactly one is true. */
export function agentSetupToModes(setup: AgentSetup): {
  claudeMode: boolean
  claudeAgentsMode: boolean
  antigravityMode: boolean
  codexMode: boolean
  piMode: boolean
  opencodeMode: boolean
} {
  return {
    claudeMode: setup.kind === 'claude',
    claudeAgentsMode: setup.kind === 'claude-agents',
    antigravityMode: setup.kind === 'antigravity',
    codexMode: setup.kind === 'codex',
    piMode: setup.kind === 'pi',
    opencodeMode: setup.kind === 'opencode'
  }
}

/** Whether a setup accepts a one-shot launch prompt.
 *
 *  `claude agents` is spawned bare and rejects a positional prompt, and a plain
 *  terminal would run the text as a shell command. Exported so the UI and the
 *  spawn path share ONE answer: they used to each carry their own, which let the
 *  group's `+` row promise a prompt that the launch then silently dropped. */
export function agentAcceptsPrompt(setup: AgentSetup | null): boolean {
  return !!setup && setup.kind !== 'claude-agents'
}

/** Reject anything the preference file might hold from an older build or a
 *  hand-edit: an unknown kind would launch nothing at all. Exported so the
 *  hardening is testable — it is the only thing standing between a hand-edited
 *  preference file and a launch button that does nothing. */
function isProfilePick(id: string): boolean {
  if (id.startsWith('builtin-')) return false
  if (Object.values(CHAT_PROFILE_IDS).includes(id)) return false
  return chatProfileSource(id) === undefined
}

export function parseSetup(raw: unknown): AgentSetup | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.kind !== 'string') return null
  if (!AGENT_KINDS.includes(value.kind as AgentKind)) return null
  const kind = value.kind as AgentKind
  return {
    kind,
    dangerousMode: value.dangerousMode === true,
    ...(typeof value.claudeProfileId === 'string' && (kind === 'claude' || kind === 'claude-agents')
      ? { claudeProfileId: value.claudeProfileId }
      : {}),
    ...(typeof value.codexAccountId === 'string' && kind === 'codex'
      ? { codexAccountId: value.codexAccountId }
      : {}),
    // A launch profile is remembered only when it was a pick (Advanced): the
    // launcher before PRDCT-4423 stored the transport on every launch, and a
    // built-in or chat-form id kept from then would hold the button to one
    // transport whatever the interaction mode says (verifier, round 2).
    ...(typeof value.launchProfileId === 'string' && isProfilePick(value.launchProfileId)
      ? { launchProfileId: value.launchProfileId }
      : {}),
    ...(typeof value.model === 'string' && isValidModelName(value.model)
      ? { model: value.model }
      : {}),
    ...(typeof value.connectionId === 'string' && (kind === 'pi' || kind === 'opencode')
      ? {
          connectionId: value.connectionId,
          ...(typeof value.connectionLabel === 'string'
            ? { connectionLabel: value.connectionLabel }
            : {})
        }
      : {})
  }
}

interface LaunchPrefsState {
  /** Workspace id (or `NO_WORKSPACE_KEY`) → the last agent setup launched there.
   *  Per workspace, not global: different workspaces are different work. */
  byWorkspace: Record<string, AgentSetup>
  /** True once the preference file has been read. Until then every workspace
   *  reads as the default, so the UI never flashes a stale remembered agent. */
  loaded: boolean
}

export const useLaunchPrefsStore = create<LaunchPrefsState>(() => ({
  byWorkspace: {},
  loaded: false
}))

/** The setup the agent button launches for a workspace: what was last launched
 *  there, or the default when that workspace has launched nothing yet. */
export function getLastAgentSetup(workspaceId: string | null): AgentSetup {
  const key = workspaceId ?? NO_WORKSPACE_KEY
  const setup = useLaunchPrefsStore.getState().byWorkspace[key] ?? DEFAULT_AGENT_SETUP
  // With "Use the recommended account" on, the account a past launch went out
  // on is a memory, not a choice: the agent button, a group's `+` and the
  // new-session button replay this setup, and a remembered account would reach
  // accountForLaunch as an explicit pick and skip the recommendation every
  // time. The kind, the permissions and the launch profile still replay; the
  // account is picked fresh. An account clicked in the caret menu is still
  // honoured for that launch, which goes through launchAgent, not here.
  if (useAccountPolicyStore.getState().useRecommendedAccount) {
    const rest = { ...setup }
    delete rest.claudeProfileId
    delete rest.codexAccountId
    delete rest.connectionId
    delete rest.connectionLabel
    return rest
  }
  return setup
}

/** Remember a setup as this workspace's default. Called on every agent launch,
 *  including the ones that went through the caret — picking a different agent
 *  is what makes it the remembered one. */
export function rememberAgentSetup(workspaceId: string | null, setup: AgentSetup): void {
  const key = workspaceId ?? NO_WORKSPACE_KEY
  const byWorkspace = { ...useLaunchPrefsStore.getState().byWorkspace, [key]: setup }
  useLaunchPrefsStore.setState({ byWorkspace })
  window.electronAPI?.preferencesSet(PREF_KEY, byWorkspace).catch(() => {})
}

/** Hydrate from the preference file. Called once from the boot sequence; a
 *  failure leaves every workspace on the default rather than blocking boot. */
export async function loadLaunchPrefs(): Promise<void> {
  try {
    const raw = await window.electronAPI?.preferencesGet(PREF_KEY)
    const byWorkspace: Record<string, AgentSetup> = {}
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const setup = parseSetup(value)
        if (setup) byWorkspace[key] = setup
      }
    }
    useLaunchPrefsStore.setState({ byWorkspace, loaded: true })
  } catch {
    useLaunchPrefsStore.setState({ loaded: true })
  }
}
