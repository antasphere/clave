/**
 * The shape and the store of a server's settings as this Mac sees them, and
 * the one read the launch path needs of them (PRDCT-4162): a module with no
 * dependency on the usage store, so `lib/launch-session.ts` can read a
 * server's profiles and accounts at a server launch without pulling the
 * usage store into every test that imports the launch path (the usage store
 * listens to the document at load). Everything that reads the server, keeps
 * it current and summarizes its usage stays in `server-settings-store.ts`,
 * which re-exports what is here.
 */
import { create } from 'zustand'
import type { ClaudeAccount, CodexAccount } from '../../../preload/index.d'
import {
  BUILT_IN_LAUNCH_PROFILES,
  type LaunchProfile,
  type LaunchProfilePreferences,
  type LauncherFamily
} from '../../../shared/agent-launch'
import type { AccountUsageSummary } from './usage-store'

export type ServerUsageProvider = 'claude' | 'codex'

/**
 * One server's settings as this Mac sees them: its accounts, their usage and
 * its launch profiles, read through the fleet bridge and kept current by the
 * server's push events. Nothing here is this Mac's own settings; the local
 * stores (`claude-profile-store`, `codex-account-store`, `usage-store`,
 * `launch-profile-store`) stay the truth for the local machine, and a server
 * never writes into them.
 */
export interface ServerSettings {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** One safe sentence, never the raw error. */
  error: string | null
  /** The server's list as it answered, the Default first. */
  claude: ClaudeAccount[]
  /** The server's list as it answered, the Default first. */
  codex: CodexAccount[]
  migrated: string[]
  profiles: LaunchProfilePreferences | null
  usage: {
    claude: Record<string, AccountUsageSummary>
    codex: Record<string, AccountUsageSummary>
  }
}

export const useServerSettingsStore = create<{ byServer: Record<string, ServerSettings> }>(() => ({
  byServer: {}
}))

/** The launch profiles of a family on that server: the built-ins and its own,
 *  by the rule of launch-profile-store's profilesFor. */
export function serverProfilesFor(
  settings: Pick<ServerSettings, 'profiles'>,
  family: LauncherFamily
): LaunchProfile[] {
  return [...BUILT_IN_LAUNCH_PROFILES, ...(settings.profiles?.customProfiles ?? [])].filter(
    (profile) => profile.family === family
  )
}
