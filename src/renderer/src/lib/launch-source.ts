/**
 * Where a launch's choices come from (PRDCT-4162): the machine a new tab
 * will run on owns the executables, the launch profiles and the
 * subscriptions, so the launcher's rows are built from THAT machine's
 * settings. This Mac's source reads the local stores; a server's source reads
 * the settings this Mac keeps of it (`server-settings-store`, read over the
 * server's connection and kept current by its pushes). The launcher renders
 * one source the same way whichever machine it is, so the "Run on <server>"
 * section offers what the server can start, chat forms and saved profiles
 * included, the way the top section does for the machine the active
 * workspace lives on. Until PRDCT-4162 the server section was a second,
 * hand-written list of three rows.
 */
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import {
  DEFAULT_LAUNCH_PROFILE_PREFERENCES,
  resolveLaunchProfile,
  type LaunchProfile,
  type LauncherFamily
} from '../../../shared/agent-launch'
import {
  profilesFor,
  selectedChatProfile,
  selectedLaunchProfile
} from '../store/launch-profile-store'
import { CHAT_PROFILE_IDS, chatDefaultFor } from '../../../shared/open-session-modes'
import { connectionsForModel, type ModelConnection } from './switch-account'
import { describeClaudeProfileAuth, useClaudeProfileStore } from '../store/claude-profile-store'
import { describeCodexAccountAuth, useCodexAccountStore } from '../store/codex-account-store'
import { capStatusLine, useClaudeAccountsUsage, useCodexAccountsUsage } from '../store/usage-store'
import { serverProfilesFor, type ServerSettings } from '../store/server-settings-store'

/** The families whose sessions run on an account of a pool. */
export type PooledFamily = 'claude' | 'codex'

/** An account row of the caret menu, whichever provider and machine. */
export interface LaunchAccount {
  id: string
  label: string
  title: string
  /** The account's shared headroom, then every family that is out
   *  ("60% left · Overall · Fable out · back in 2d 5h"), or null before a read. */
  headroom: string | null
}

export interface LaunchSource {
  /** The machine: `LOCAL_SERVER_ID` for this Mac, else the saved server's id. */
  serverId: string
  /** How the menu names the machine: `This Mac`, or the server's saved name. */
  name: string
  /** Whether the machine's settings are known: a server not read yet offers
   *  its built-ins and no account, and its rows fill in when the read lands. */
  ready: boolean
  profilesFor(family: LauncherFamily): LaunchProfile[]
  selectedProfileId(family: LauncherFamily): string
  accounts(family: PooledFamily): LaunchAccount[]
  selectedAccountId(family: PooledFamily): string | null
  /** The chat profile a chat launch of the family opens on (PRDCT-4423):
   *  the family's chat default in the workspace, else its built-in chat;
   *  undefined for a family with no chat view. */
  chatProfileId(family: LauncherFamily): string | undefined
  /** The connections a launch of `model` could run on, judged for that
   *  model, the suggested one marked (`connectionsForModel`). */
  connections(family: PooledFamily, model: string | undefined): ModelConnection[]
}

/** This Mac, from the local stores; read at render so the caller's own
 *  subscriptions to those stores decide when the menu redraws. */
export function localLaunchSource(workspaceId: string | null): LaunchSource {
  return {
    serverId: LOCAL_SERVER_ID,
    name: 'This Mac',
    ready: true,
    profilesFor,
    selectedProfileId: (family) => selectedLaunchProfile(family, workspaceId).id,
    accounts: (family) => {
      if (family === 'claude') {
        const usage = useClaudeAccountsUsage.getState().byAccount
        return useClaudeProfileStore.getState().profiles.map((account) => ({
          id: account.id,
          label: account.label,
          title: `${account.label} · ${describeClaudeProfileAuth(account)}`,
          headroom: capStatusLine(usage[account.id])
        }))
      }
      const usage = useCodexAccountsUsage.getState().byAccount
      return useCodexAccountStore.getState().accounts.map((account) => ({
        id: account.id,
        label: account.label,
        title: `${account.label} · ${describeCodexAccountAuth(account)}`,
        headroom: capStatusLine(usage[account.id])
      }))
    },
    selectedAccountId: (family) =>
      family === 'claude'
        ? useClaudeProfileStore.getState().selectedProfileId
        : useCodexAccountStore.getState().selectedAccountId,
    chatProfileId: (family) => selectedChatProfile(family, workspaceId) ?? CHAT_PROFILE_IDS[family],
    connections: (family, model) => connectionsForModel(family, model)
  }
}

/** A saved server, from the settings this Mac read of it. A server keeps no
 *  per-workspace default this Mac could name, so its selected profile is its
 *  global default; its selected account is the first it lists, its own
 *  machine login, and a launch that names none leaves the pick to the
 *  server's pool. */
export function serverLaunchSource(
  serverId: string,
  name: string,
  settings: ServerSettings
): LaunchSource {
  const preferences = settings.profiles ?? DEFAULT_LAUNCH_PROFILE_PREFERENCES
  const accounts = (family: PooledFamily): LaunchAccount[] =>
    (family === 'claude' ? settings.claude : settings.codex).map((account) => ({
      id: account.id,
      label: account.label,
      title: `${account.label} · on ${name}`,
      headroom: capStatusLine(settings.usage[family][account.id])
    }))
  return {
    serverId,
    name,
    ready: settings.status === 'ready',
    profilesFor: (family) => serverProfilesFor(settings, family),
    selectedProfileId: (family) => resolveLaunchProfile(preferences, family, null).id,
    accounts,
    selectedAccountId: (family) => accounts(family)[0]?.id ?? null,
    chatProfileId: (family) =>
      chatDefaultFor(preferences, family, null) ?? CHAT_PROFILE_IDS[family],
    connections: (family, model) => connectionsForModel(family, model, serverId)
  }
}
