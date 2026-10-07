/**
 * The shell's settings source: the managers' module singletons, the login
 * jobs (main has the PTY) and the Dock. The in-process server reads and
 * writes the settings through it (`server/clave-server.ts` hands it to
 * `startEmbedded`), and so do the IPC handlers, so the two routes are one
 * truth and one stream of events.
 *
 * Under `--test-no-activate` the object is also reachable as
 * `globalThis.__claveE2E.settings` (the test hooks' namespace, lane A's name),
 * the seam the end-to-end specs replace a usage read on (they used to replace
 * the IPC handler, which the server route never goes through). A spec assigns
 * a method of the object; both routes call it at call time.
 */
import type { SettingsSourceService } from '@clave/server'
import { claudeAccountsManager } from '../claude-accounts'
import { codexAccountsManager } from '../codex-accounts'
import { usageManager } from '../usage-manager'
import { codexUsageManager } from '../codex-usage'
import { piUsageManager } from '../pi-usage'
import { launchProfileManager } from '../launch-profile-manager'
import { preferencesManager } from '../preferences-manager'
import { workspaceManager } from '../workspace-manager'
import { applyAppIcon } from '../app-icon'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { settingsSourceFromManagers } from './source'

export const shellSettingsSource: SettingsSourceService = settingsSourceFromManagers({
  claudeAccounts: claudeAccountsManager,
  codexAccounts: codexAccountsManager,
  claudeUsage: usageManager,
  codexUsage: codexUsageManager,
  piUsage: piUsageManager,
  launchProfiles: launchProfileManager,
  preferences: preferencesManager,
  workspaces: workspaceManager,
  // Loaded on first use so this module's own import graph reaches no PTY
  // backend (a unit test loads it without one); the app's boot imports the
  // same login manager statically, so in the app nothing loads twice.
  logins: () => import('../account-login').then((m) => m.accountLoginManager),
  applyAppIcon
})

if (TEST_NO_ACTIVATE) {
  const hooks = globalThis as { __claveE2E?: { settings?: SettingsSourceService } }
  ;(hooks.__claveE2E ??= {}).settings = shellSettingsSource
}
