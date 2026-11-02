import { BUILT_IN_LAUNCH_PROFILES } from '../../../shared/agent-launch'
import {
  resolveProfileRef,
  resolveSpawnModes,
  type OpenSessionMode
} from '../../../shared/open-session-modes'
import type { PiThinkingLevel } from '../../../shared/agent-launch'
import { useSessionStore } from '../store/session-store'

/** The server owns the executable and subscriptions. Never resolve these
 * against the Mac's profile or account stores for a remote launch. */
export async function openFleetSession(
  serverId: string,
  workspaceId: string | undefined,
  groupId: string | undefined,
  payload: {
    cwd: string
    mode?: OpenSessionMode
    chat?: boolean
    profile?: string
    account?: string
    dangerous?: boolean
    model?: string
    provider?: string
    thinking?: PiThinkingLevel
    command?: string
    autoRun?: boolean
    prompt?: string
    name?: string
    callerSessionId?: string
    attachToParent?: boolean
  }
): Promise<{ sessionId: string; groupId: string | null; serverId: string }> {
  const mode = payload.mode ?? 'claude'
  const { family, ...modes } = resolveSpawnModes(payload)
  const profileRef = resolveProfileRef(payload)
  if (payload.account && !modes.claudeMode && !modes.codexMode)
    throw new Error(
      `The account argument applies to claude and codex modes only (got mode "${mode}")`
    )
  const settings = family ? await window.electronAPI.fleetLaunchSettings(serverId) : null
  const profile =
    profileRef && settings
      ? [...BUILT_IN_LAUNCH_PROFILES, ...settings.profiles.customProfiles].find(
          (p) =>
            p.family === family &&
            (p.id === profileRef || p.name.toLowerCase() === profileRef.toLowerCase())
        )
      : undefined
  if (profileRef && !profile)
    throw new Error(`Unknown ${family} launch profile "${profileRef}" on the server`)
  const accounts = modes.codexMode ? settings?.codexAccounts : settings?.claudeAccounts
  const account =
    payload.account && payload.account !== 'any'
      ? accounts?.find((a) => a.id === payload.account || a.label === payload.account)
      : undefined
  if (payload.account && payload.account !== 'any' && !account)
    throw new Error(`Unknown account "${payload.account}" on the server`)
  const info = await window.electronAPI.fleetStart(serverId, payload.cwd, {
    ...modes,
    ...(workspaceId ? { workspaceId } : {}),
    // Sending the server's profile also prevents the preload from substituting
    // a Mac profile with the same ID.
    ...(profile ? { launchProfileId: profile.id, launchProfile: profile } : {}),
    ...(account && modes.claudeMode
      ? { claudeProfileId: account.id, claudeProfileLabel: account.label }
      : {}),
    ...(account && modes.codexMode
      ? { codexAccountId: account.id, codexAccountLabel: account.label }
      : {}),
    ...(modes.piMode ? { piProvider: payload.provider, piThinking: payload.thinking } : {}),
    initialCommand: mode === 'terminal' ? payload.command : undefined,
    autoExecute: mode === 'terminal' && !!payload.command && payload.autoRun !== false,
    initialPrompt: mode !== 'terminal' ? payload.prompt : undefined,
    ...(payload.attachToParent && payload.callerSessionId
      ? { spawnedBy: payload.callerSessionId }
      : {})
  })
  if (payload.name) await window.electronAPI.setSessionDisplayName(info.id, payload.name, true)
  await window.electronAPI.fleetSnapshot(serverId)
  if (groupId) useSessionStore.getState().moveItems([info.id], groupId, 'inside')
  await window.electronAPI.resizeSession(info.id, 120, 30)
  return { sessionId: info.id, groupId: groupId ?? null, serverId }
}
