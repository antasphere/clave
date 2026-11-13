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
import { ownerOf } from './fleet-identity'
import { useProviderConnectionsStore } from '../store/provider-connections-store'
import { HARNESS_BY_ID } from '../../../shared/harness'
import type { ProviderConnectionView } from '@clave/contract/settings/connections'
import {
  providerConnectionSpawnFields,
  resolveProviderConnection
} from '../../../shared/provider-connection-pick'

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

/** The stored connection an agent's `account` names on a Pi or OpenCode open
 *  (PRDCT-4496), among that machine's (lane B's store, its list read first
 *  when the window holds none yet, as `withoutGoneConnection` does), by the
 *  one rule every road reads (`resolveProviderConnection`): its id and its
 *  name for the spawn, or the refusal in the sentence the other roads say. */
export async function machineProviderConnection(
  machine: string,
  harness: 'pi' | 'opencode',
  ref: string
): Promise<{ connectionId: string; connectionLabel: string }> {
  const store = useProviderConnectionsStore.getState()
  const held = store.byMachine[machine]
  if (!held || held.loading) await store.load(machine)
  const entry = useProviderConnectionsStore.getState().byMachine[machine]
  if (!entry || entry.error)
    throw new Error(entry?.error ?? 'The connections could not be read from this machine.')
  const picked = resolveProviderConnection(
    HARNESS_BY_ID[harness],
    entry.connections as readonly ProviderConnectionView[],
    ref
  )
  if (!picked.ok) throw new Error(picked.reason)
  return providerConnectionSpawnFields(picked.connection) as {
    connectionId: string
    connectionLabel: string
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
  // A conversation a tab of this server still holds is answered by that tab
  // (PRDCT-4321): a stopped one restarted in place, never a second tab on
  // one conversation. A server with its own History says so itself; an older
  // one lists nothing, and this window's tabs are the only word.
  if (payload.resumeSessionId && mode !== 'terminal') {
    const holder = useSessionStore
      .getState()
      .sessions.find(
        (s) =>
          ownerOf(s.id) === serverId &&
          (s.claudeSessionId === payload.resumeSessionId ||
            s.piSessionId === payload.resumeSessionId)
      )
    if (holder) {
      if (!holder.alive) {
        const result = await window.electronAPI.restartSession(holder.id, { onlyIfStopped: true })
        if ('error' in result) throw new Error(result.error)
        await window.electronAPI.fleetSnapshot(serverId)
      }
      return { sessionId: holder.id, groupId: groupId ?? null, serverId }
    }
  }
  const { family, ...modes } = resolveSpawnModes(payload)
  const providerHarness = modes.piMode ? 'pi' : modes.opencodeMode ? 'opencode' : null
  if (payload.account && !modes.claudeMode && !modes.codexMode && !providerHarness)
    throw new Error(
      `The account argument applies to claude, codex, pi and opencode modes only (got mode "${mode}")`
    )
  // Pi and OpenCode run on one of the server's stored connections when the
  // account names one (PRDCT-4496); with none, on the login inside the harness.
  const connection =
    payload.account && providerHarness
      ? await machineProviderConnection(serverId, providerHarness, payload.account)
      : {}
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
  // A Pi or OpenCode account named a stored connection above, not an account.
  const accountRef = providerHarness ? undefined : payload.account
  const account =
    accountRef && accountRef !== 'any'
      ? accounts?.find((a) => a.id === accountRef || a.label === accountRef)
      : undefined
  if (accountRef && accountRef !== 'any' && !account)
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
    ...connection,
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
