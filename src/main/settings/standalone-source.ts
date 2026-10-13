/**
 * The standalone server's settings source: the same managers, on the
 * standalone ports (JSON documents under the server's data directory, the
 * macOS Keychain for the secrets), with no login jobs and no Dock. A login
 * or an icon asked of this server answers `CapabilityUnavailable` with the
 * reason; wave 3's Node process beside the server is what takes them on.
 *
 * The Antasphere account (PRDCT-3259) it does own: the same manager as the
 * shell's, on these ports, its issuer read off this process's environment,
 * its session sealed in the Keychain (serialised to ASCII first) and
 * restored from the data directory at start. No browser opens here: a
 * sign-in answers the handoff to the client that asked, and the shell on
 * the other end opens it.
 *
 * Installing the ports happens here, once, before any manager is touched:
 * the managers resolve their ports lazily and would otherwise throw with the
 * fix named (`ports/registry.ts`). Nothing here imports Electron; the entry
 * runs under Bun.
 */
import type { SettingsSourceService } from '@clave/server'
import { installSettingsPorts, keychainFileFromEnv, standalonePorts } from '../ports'
import { AntasphereAccountManager } from '../antasphere-account'
import { claudeAccountsManager } from '../claude-accounts'
import { codexAccountsManager } from '../codex-accounts'
import { usageManager } from '../usage-manager'
import { codexUsageManager } from '../codex-usage'
import { piUsageManager } from '../pi-usage'
import { launchProfileManager } from '../launch-profile-manager'
import { preferencesManager } from '../preferences-manager'
import { workspaceManager } from '../workspace-manager'
import { settingsSourceFromManagers } from './source'

export interface StandaloneSettings {
  settings: SettingsSourceService
  /** The server is stopping: nothing of the login stays listening or fires later. */
  shutdown: () => void
}

export function standaloneSettingsSource(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env
): StandaloneSettings {
  installSettingsPorts(standalonePorts({ dataDir, keychainFile: keychainFileFromEnv(env) }))
  // Every account diagnostic goes to STDERR: the server's stdout is the
  // launcher's protocol (`scripts/server-process.mjs` reads one JSON line
  // off it, the first), and the manager's default logger is `console.log`,
  // which put a restored session's line there ahead of the announcement.
  // What is logged is the event name and the manager's own safe fields
  // (codes, a port, a boolean), never a token, a URL or the hub's text.
  const antasphere = new AntasphereAccountManager({
    env,
    log: (event, fields) =>
      process.stderr.write(
        `[antasphere-account] ${event}${fields ? ` ${JSON.stringify(fields)}` : ''}\n`
      )
  })
  // The ports are installed: the stored session is read back now. A state,
  // never a rejection; a login is never what stops the server from starting.
  void antasphere.restore()
  const settings = settingsSourceFromManagers({
    claudeAccounts: claudeAccountsManager,
    codexAccounts: codexAccountsManager,
    claudeUsage: usageManager,
    codexUsage: codexUsageManager,
    piUsage: piUsageManager,
    launchProfiles: launchProfileManager,
    preferences: preferencesManager,
    workspaces: workspaceManager,
    antasphere
  })
  return { settings, shutdown: () => antasphere.shutdown() }
}
