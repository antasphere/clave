/**
 * The shell's settings source: the managers' module singletons, the login
 * jobs (main has the PTY) and the Dock. The in-process server reads and
 * writes the settings through it (`server/clave-server.ts` hands it to
 * `startEmbedded`), and so do the IPC handlers, so the two routes are one
 * truth and one stream of events.
 *
 * The Antasphere account (PRDCT-3259) is the server's: the shell holds the
 * manager only while the server runs in-process. With the server elsewhere,
 * attached to one running under another process or started by the shell as
 * its own separate child (the packaged default on macOS), the shell builds
 * none, so no stored session under the app's own user data is restored or
 * offered as a login: the window asks the server, and the IPC route refuses.
 * Which it is follows the ONE launch decision main takes (`server-launch.ts`,
 * from the environment, the command line, whether the app is packaged and
 * the platform); this module decides nothing of its own. It used to resolve
 * the mode from the environment alone, which left a separate server with a
 * shell manager no login reached, refusing the server's handoff at the open.
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
import { AntasphereAccountManager } from '../antasphere-account'
import { shellOwnsAntasphereAccount } from '../server-boot'
import { serverLaunch } from '../server-launch'
import { TEST_NO_ACTIVATE } from '../test-mode'
import {
  helperPreferences,
  installHelperPreferences,
  remoteHelperPreferences,
  type HelperPreferencesOwner
} from '../helpers/preferences'
import { settingsSourceFromManagers } from './source'

/** The Antasphere account manager, while this process is the server; null
 *  when the server runs elsewhere (attached, or the shell's own separate
 *  child). `index.ts` shuts it down at quit; the IPC handler asks it which
 *  login generation a browser handoff may be opened for. */
export const shellAntasphereAccount: AntasphereAccountManager | null = shellOwnsAntasphereAccount(
  serverLaunch
)
  ? new AntasphereAccountManager({})
  : null

/** This Mac's helpers' preference as main reaches it (PRDCT-4330): main's own
 *  store while the server runs in this process, which then owns it; with the
 *  server elsewhere (the shell's separate child, the packaged default, or one
 *  attached), the server owns it and main asks it over the server's API at
 *  each call, never through a file of its own (ADR 0003). The client loads on
 *  the first call, not at boot (`boot-graph.test.ts`). */
function shellHelperPreferences():
  | typeof helperPreferences
  | ReturnType<typeof remoteHelperPreferences> {
  if (serverLaunch.mode === 'in-process') return helperPreferences
  return (remoteHelpers ??= remoteHelperPreferences(
    async () =>
      (await (
        await import('../mcp/server-client')
      ).serverClient.api()) as unknown as HelperPreferencesOwner
  ))
}
let remoteHelpers: ReturnType<typeof remoteHelperPreferences> | null = null

export const shellSettingsSource: SettingsSourceService = settingsSourceFromManagers({
  claudeAccounts: claudeAccountsManager,
  codexAccounts: codexAccountsManager,
  claudeUsage: usageManager,
  codexUsage: codexUsageManager,
  piUsage: piUsageManager,
  launchProfiles: launchProfileManager,
  preferences: preferencesManager,
  workspaces: workspaceManager,
  helpers: shellHelperPreferences(),
  // Loaded on first use so this module's own import graph reaches no PTY
  // backend (a unit test loads it without one); the app's boot imports the
  // same login manager statically, so in the app nothing loads twice.
  logins: () => import('../account-login').then((m) => m.accountLoginManager),
  applyAppIcon,
  ...(shellAntasphereAccount && { antasphere: shellAntasphereAccount })
})

// The helpers main runs (the git panel's one-shots, the digests, and every
// helper of an in-process server) read this Mac's ONE preference at each call
// (PRDCT-4330), whichever process owns it.
installHelperPreferences(shellHelperPreferences())

if (TEST_NO_ACTIVATE) {
  const hooks = globalThis as { __claveE2E?: { settings?: SettingsSourceService } }
  ;(hooks.__claveE2E ??= {}).settings = shellSettingsSource
}
