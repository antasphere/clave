/** `--test-no-activate`: the automated-testing mode where the app never steals
 *  the machine's focus — nor the screen.
 *
 *  An E2E run launches a second Electron instance on the same desktop the human
 *  is working on. By default that instance activates: it becomes the frontmost
 *  app, puts an icon in the Dock, and every `ready-to-show` pulls the keyboard
 *  away mid-sentence. With this flag the instance runs as a macOS *accessory*
 *  (no Dock icon, never frontmost) and its windows are NEVER SHOWN: even
 *  `showInactive()` puts a new window at the front of the desktop, over what
 *  the human is doing. Playwright drives the renderer over the debugger
 *  protocol and needs no window on screen; `backgroundThrottling: false` keeps
 *  the hidden page's timers and animation frames running. The one thing a
 *  hidden window cannot give is a pixel-accurate screenshot — no spec relies
 *  on one.
 *
 *  Read from `process.argv` exactly like `user-data-override.ts` reads
 *  `--user-data-dir`: a CLI flag on the launch line, nothing more. It defaults
 *  OFF, and off it changes nothing at all.
 *
 *  Consequence worth knowing before you write a test against it: under the
 *  accessory policy `BrowserWindow.getFocusedWindow()` can be null,
 *  `win.isFocused()` false and `win.isVisible()` false for the whole run.
 *  Assert Clave-internal focus (the store's focused session, the window
 *  registry) rather than OS focus, and never a window being on screen.
 */
export const TEST_NO_ACTIVATE = process.argv.includes('--test-no-activate')

/** Quota fixtures opt out of the machine login before the first window
 * mounts. Token accounts still exercise their recording probe adapters. */
export const TEST_NO_MACHINE_USAGE =
  TEST_NO_ACTIVATE && process.argv.includes('--test-no-machine-usage')

/** `--test-onboarding`: a test instance shows the first-run walk. Without it
 *  it never does, so the many specs that start on an empty data folder (a
 *  first install, to the walk) open straight on the app as they always have. */
export const TEST_ONBOARDING = TEST_NO_ACTIVATE && process.argv.includes('--test-onboarding')

/** True when the instance runs on a profile of its own (`--user-data-dir`, see
 *  `user-data-override.ts`). The folders that are otherwise the machine's, the
 *  `~/.clave` plugins and skins, follow the profile too, so a dev instance
 *  beside the installed app never rewrites the installed app's plugin grants. */
export const OWN_PROFILE = process.argv.some((arg) => arg.startsWith('--user-data-dir'))

/**
 * `--test-version=<semver>`: the version the app REPORTS itself to be, for the
 * updater's channel logic only, and only under `--test-no-activate`.
 *
 * A dev build's `app.getVersion()` is whatever package.json says, always a
 * stable version, so the one branch of the channel logic that matters most —
 * a user on a beta who leaves the channel is offered the stable release, a
 * downgrade electron-updater refuses unless told otherwise — could never be
 * reached by an E2E spec. This flag lets a spec launch as `2.0.0-beta.1`. It
 * does not touch electron-updater's own `currentVersion` (a dev build never
 * checks anyway) and it does not exist outside test mode.
 */
export const TEST_VERSION: string | null = TEST_NO_ACTIVATE
  ? (process.argv.find((a) => a.startsWith('--test-version='))?.slice('--test-version='.length) ??
    null)
  : null

/** The value of `--<flag>=<value>` under test mode, else null. */
function testFlag(flag: string): string | null {
  if (!TEST_NO_ACTIVATE) return null
  const prefix = `--${flag}=`
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? null
}

/**
 * `--test-install-script=<path>`: the script Setup's "Make this Mac a server"
 * runs instead of the bundled `install-server.sh`, so a spec drives the whole
 * install with a stand-in that writes its phases and an install.env and never
 * builds or starts a real service. Test mode only.
 */
export const TEST_INSTALL_SCRIPT: string | null = testFlag('test-install-script')

/**
 * `--test-install-config=<dir>`: the config directory that holds
 * `<name>/install.env`, read instead of `~/.config` and handed to the script
 * as `XDG_CONFIG_HOME`, so a spec never reads or writes the machine's own
 * server install. Test mode only.
 */
export const TEST_INSTALL_CONFIG: string | null = testFlag('test-install-config')

/**
 * `--test-tailscale-status=<file>`: a `tailscale status --json` document read
 * instead of running the CLI, so a spec sees an invented tailnet rather than
 * the machine's. Test mode only.
 */
export const TEST_TAILSCALE_STATUS: string | null = testFlag('test-tailscale-status')

/**
 * `--test-scan-port=<port>`: the port the tailnet scan probes instead of the
 * server's default, so a spec's local stand-in server answers. Null when
 * absent or not a port. Test mode only.
 */
export const TEST_SCAN_PORT: number | null = ((): number | null => {
  const value = testFlag('test-scan-port')
  if (value === null || !/^\d+$/.test(value)) return null
  const port = Number(value)
  return port >= 1 && port <= 65535 ? port : null
})()
