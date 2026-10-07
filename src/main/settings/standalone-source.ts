/**
 * The standalone server's settings source: the same managers, on the
 * standalone ports (JSON documents under the server's data directory, the
 * macOS Keychain for the secrets), with no login jobs and no Dock. A login
 * or an icon asked of this server answers `CapabilityUnavailable` with the
 * reason; wave 3's Node process beside the server is what takes them on.
 *
 * Installing the ports happens here, once, before any manager is touched:
 * the managers resolve their ports lazily and would otherwise throw with the
 * fix named (`ports/registry.ts`). Nothing here imports Electron; the entry
 * runs under Bun.
 */
import type { SettingsSourceService } from '@clave/server'
import { installSettingsPorts, standalonePorts } from '../ports'
import { claudeAccountsManager } from '../claude-accounts'
import { codexAccountsManager } from '../codex-accounts'
import { usageManager } from '../usage-manager'
import { codexUsageManager } from '../codex-usage'
import { piUsageManager } from '../pi-usage'
import { launchProfileManager } from '../launch-profile-manager'
import { preferencesManager } from '../preferences-manager'
import { workspaceManager } from '../workspace-manager'
import { settingsSourceFromManagers } from './source'

export function standaloneSettingsSource(dataDir: string): SettingsSourceService {
  installSettingsPorts(standalonePorts({ dataDir }))
  return settingsSourceFromManagers({
    claudeAccounts: claudeAccountsManager,
    codexAccounts: codexAccountsManager,
    claudeUsage: usageManager,
    codexUsage: codexUsageManager,
    piUsage: piUsageManager,
    launchProfiles: launchProfileManager,
    preferences: preferencesManager,
    workspaces: workspaceManager
  })
}
