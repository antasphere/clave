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
