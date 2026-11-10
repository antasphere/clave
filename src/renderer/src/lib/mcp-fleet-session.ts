import { BUILT_IN_LAUNCH_PROFILES } from '../../../shared/agent-launch'
import {
  chatDefaultFor,
  resolveProfileRef,
  resolveSpawnModes,
  type OpenSessionMode
} from '../../../shared/open-session-modes'
import type { PiThinkingLevel } from '../../../shared/agent-launch'
import { useSessionStore } from '../store/session-store'
import { useFleetStore } from '../store/fleet-store'
import { describeServerState } from './server-connection-text'

/** The state this window holds of a server, in the words its Servers page
 *  uses (PRDCT-4165): a tool that cannot reach a server says the same thing
 *  the person reads in Settings, the reason included, instead of a transport
 *  error. A server still connecting is let through: the fleet client waits
 *  for its welcome, as it always did. The fleet client's own refusal stays
 *  the last line of defence. */
export function assertServerConnected(serverId: string): void {
  const fleet = useFleetStore.getState()
  const connection = fleet.connections.find((c) => c.id === serverId)
  // A server this window has no saved connection for is left to the fleet
  // client's own refusal: the target was resolved from the saved list already.
  if (!connection) return
  const status = fleet.statuses[serverId]
  const { error } = describeServerState(status, connection.enabled)
  if (!connection.enabled)
    throw new Error(`${connection.name} is disconnected. Reconnect it in Settings → Servers.`)
  switch (status?.state) {
    case 'offline':
      throw new Error(`${connection.name} is unreachable. ${error ?? ''}`.trim())
    case 'unauthorized':
      throw new Error(`${connection.name} refused its token. ${error ?? ''}`.trim())
    default:
      // connected, or on its way there (connecting, reconnecting, not reported yet)
      return
  }
}

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
    /** A past conversation of this server to continue (PRDCT-4321). */
    resumeSessionId?: string
    /** The launch profile and the server's own account that conversation ran
     *  on (PRDCT-4321): used when the call names no profile, chat or account
     *  of its own. */
    resumeLaunchProfileId?: string
    resumeAccount?: { id: string; label?: string }
    callerSessionId?: string
    attachToParent?: boolean
  }
): Promise<{ sessionId: string; groupId: string | null; serverId: string }> {
  assertServerConnected(serverId)
  const mode = payload.mode ?? 'claude'
  const { family, ...modes } = resolveSpawnModes(payload)
  if (payload.account && !modes.claudeMode && !modes.codexMode)
    throw new Error(
      `The account argument applies to claude and codex modes only (got mode "${mode}")`
    )
  const settings = family ? await window.electronAPI.fleetLaunchSettings(serverId) : null
  // The chat the server itself would open: its own global default's chat
  // form. A fleet server holds no per-workspace default the Mac could name
  // (the Mac's launcher keeps its server-workspace overrides in the Mac's own
  // file), so the workspace is not consulted here; an explicit profile still
  // names one of the server's by id.
  const profileRef = resolveProfileRef(
    payload,
    family && settings ? chatDefaultFor(settings.profiles, family, null) : undefined
  )
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
  // A resumed conversation of this server (PRDCT-4321) comes back on the
  // profile and the account it ran on, when nothing above chose one.
  const resumedAccount = !account && modes.claudeMode ? payload.resumeAccount : undefined
  const info = await window.electronAPI.fleetStart(serverId, payload.cwd, {
    ...modes,
    ...(workspaceId ? { workspaceId } : {}),
    // Sending the server's profile also prevents the preload from substituting
    // a Mac profile with the same ID.
    ...(profile
      ? { launchProfileId: profile.id, launchProfile: profile }
      : payload.resumeLaunchProfileId
        ? { launchProfileId: payload.resumeLaunchProfileId }
        : {}),
    ...(account && modes.claudeMode
      ? { claudeProfileId: account.id, claudeProfileLabel: account.label }
      : {}),
    ...(resumedAccount
      ? { claudeProfileId: resumedAccount.id, claudeProfileLabel: resumedAccount.label }
      : {}),
    ...(account && modes.codexMode
      ? { codexAccountId: account.id, codexAccountLabel: account.label }
      : {}),
    ...(modes.piMode ? { piProvider: payload.provider, piThinking: payload.thinking } : {}),
    initialCommand: mode === 'terminal' ? payload.command : undefined,
    autoExecute: mode === 'terminal' && !!payload.command && payload.autoRun !== false,
    initialPrompt: mode !== 'terminal' ? payload.prompt : undefined,
    ...(mode !== 'terminal' && payload.resumeSessionId
      ? { resumeSessionId: payload.resumeSessionId }
      : {}),
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
