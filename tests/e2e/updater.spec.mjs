// The updater's surfaces: the pull-able state, the Software Update pane, and
// the native menu.
//
// What this spec is really guarding is recoverability. The updater used to be
// push-only — main fired `update-available` once, five seconds after launch,
// and if the renderer was not listening at that instant the app simply never
// admitted an update existed. There was no way to ask, no manual check, and
// nothing in Settings or the menu bar. Since auto-update is Clave's only
// distribution channel, "the UI forgot" and "you cannot upgrade" were the same
// bug: a 1.68.0 install sat on a published 1.69.0 with no affordance at all.
//
// The second half is the beta channel: "Receive pre-release builds" is OFF by
// default and persisted, the toggle applies electron-updater's two flags (read
// back off the singleton, not off our own state), a beta on offer is named as
// one, a beta build that leaves the channel is allowed the downgrade to the
// stable release, and a beta's first run on stable data copies that data aside.
// Each of these fails silently if broken: a stable user offered a beta gets
// unfinished software with no symptom, and a beta user with no way back gets
// stuck.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, userDataDir } from './harness.mjs'

/** Open Settings → Software Update in `win`. */
async function openSoftwareUpdate(win) {
  await win.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))
  )
  await win.waitForTimeout(600)
  const nav = win.getByRole('button', { name: 'Software Update' })
  if ((await nav.count()) === 0) return false
  await nav.first().click()
  await win.waitForTimeout(600)
  return true
}

function readPreferences(dir) {
  const f = path.join(dir, 'preferences.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : {}
}

export async function run(t) {
  await stableSurfaces(t)
  await channelToggle(t)
  await betaBuild(t)
}

async function stableSurfaces(t) {
  const dir = userDataDir('updater')
  const { app, win } = await launchApp(dir)

  try {
    // --- The pull path: the fix for the lost push ---
    const state = await win.evaluate(() => window.electronAPI.getUpdaterState())
    t.check(
      'getUpdaterState() answers with a state object',
      state && typeof state === 'object',
      state
    )
    t.check('state carries a phase', typeof state?.phase === 'string', state?.phase)
    t.check(
      'state names the running version',
      typeof state?.currentVersion === 'string' && state.currentVersion.length > 0,
      state?.currentVersion
    )
    t.equal('an unpackaged build reports itself unsupported', state?.supported, false)

    // A manual check must resolve rather than throw, even where the updater
    // cannot run — the pane calls this behind its button.
    const checked = await win.evaluate(() => window.electronAPI.checkForUpdates())
    t.check('checkForUpdates() resolves a state', typeof checked?.phase === 'string', checked)

    // --- The native menu ---
    const menu = await app.evaluate(({ Menu }) => {
      const m = Menu.getApplicationMenu()
      if (!m) return null
      return m.items.map((i) => ({
        label: i.label,
        role: i.role,
        sub: i.submenu ? i.submenu.items.map((s) => s.label).filter(Boolean) : []
      }))
    })
    t.check('an application menu is installed', menu !== null)
    const appMenu = menu?.[0]
    t.check(
      'the app menu offers Check for Updates',
      !!appMenu?.sub.includes('Check for Updates…'),
      appMenu?.sub
    )
    t.check(
      'the app menu offers a direct download',
      !!appMenu?.sub.includes('Download Latest Version…'),
      appMenu?.sub
    )
    // Replacing Electron's default menu means we own the standard items too.
    // Losing these would take ⌘C/⌘V away from every terminal in the app.
    const edit = menu?.find((m) => m.label === 'Edit')
    t.check(
      'the Edit menu survives, so copy and paste still work',
      !!edit && edit.sub.includes('Copy') && edit.sub.includes('Paste'),
      edit?.sub
    )
    const help = menu?.find((m) => m.role === 'help')
    t.check(
      'the Help menu exposes the updater log',
      !!help?.sub.includes('Open Updater Log'),
      help?.sub
    )

    // --- The Software Update pane ---
    await win.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))
    )
    await win.waitForTimeout(600)
    const nav = win.getByRole('button', { name: 'Software Update' })
    t.check('Settings lists a Software Update section', (await nav.count()) > 0)

    if (await nav.count()) {
      await nav.first().click()
      await win.waitForTimeout(600)
      const body = await win.locator('body').innerText()
      t.check('the pane names the running version', body.includes(`Clave ${state.currentVersion}`))
      t.check('the pane offers a manual check', body.includes('Check for Updates'))
      // The two escape hatches. Without them a user whose download keeps
      // failing has no way to get the release and nothing to send us.
      t.check('the pane offers the manual install route', body.includes('Open Releases'))
      t.check('the pane offers the updater log', body.includes('Open Log'))
      t.check('a dev build says so instead of pretending', body.includes('disabled in development'))
    }

    // --- The menu drives the renderer to the pane ---
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:open-settings-section', 'updates')
    })
    await win.waitForTimeout(700)
    const after = await win.locator('body').innerText()
    t.check(
      'Check for Updates navigates to the pane where the answer appears',
      after.includes('Software Update') && after.includes('Open Releases')
    )
  } finally {
    await app.close()
  }
}

// --- The channel toggle: off by default, confirmed before it turns on,
//     persisted, applied to the updater, and the beta on offer named as one ---
async function channelToggle(t) {
  const dir = userDataDir('updater-channel')
  rmSync(dir, { recursive: true, force: true })
  let { app, win } = await launchApp(dir)

  try {
    const state = await win.evaluate(() => window.electronAPI.getUpdaterState())
    t.equal('a fresh install is on the stable channel', state?.channel, 'stable')
    t.check(
      'a fresh install allows neither pre-releases nor downgrades',
      state?.flags?.allowPrerelease === false && state?.flags?.allowDowngrade === false,
      state?.flags
    )
    t.equal('a stable build does not call itself a pre-release', state?.currentIsPrerelease, false)
    t.equal(
      'nothing on offer is a pre-release before any check',
      state?.availableIsPrerelease,
      false
    )
    t.equal('no snapshot is taken by a stable build', state?.snapshotPath, null)
    t.check(
      'the preference is not written on by default',
      readPreferences(dir).prereleaseUpdates !== true,
      readPreferences(dir)
    )

    t.check('Settings opens on Software Update', await openSoftwareUpdate(win))
    const toggle = win.getByRole('switch', { name: 'Receive pre-release builds' })
    t.equal('the pane offers the pre-release toggle', await toggle.count(), 1)
    t.equal('the toggle is off by default', await toggle.getAttribute('aria-checked'), 'false')
    t.check(
      'the toggle carries its one-line description',
      (await win.locator('body').innerText()).includes(
        'Betas arrive like updates and share your Clave data with the stable app.'
      )
    )

    // Turning it on asks first, and asking is not applying.
    await toggle.click()
    await win.waitForTimeout(300)
    const confirm = win.getByRole('button', { name: 'Receive Pre-releases' })
    t.equal('turning the toggle on asks for confirmation', await confirm.count(), 1)
    t.check(
      "the confirmation is the app's own callout, not a native dialog",
      (await win.locator('.settings-callout').count()) >= 1
    )
    let mid = await win.evaluate(() => window.electronAPI.getUpdaterState())
    t.equal('asking has not switched the channel', mid?.channel, 'stable')
    t.equal(
      'the toggle stays off until confirmed',
      await toggle.getAttribute('aria-checked'),
      'false'
    )

    await win.getByRole('button', { name: 'Cancel' }).first().click()
    await win.waitForTimeout(300)
    t.equal('Cancel closes the confirmation', await confirm.count(), 0)
    mid = await win.evaluate(() => window.electronAPI.getUpdaterState())
    t.equal('Cancel leaves the channel stable', mid?.channel, 'stable')
    t.check('Cancel writes nothing', readPreferences(dir).prereleaseUpdates !== true)

    await toggle.click()
    await win.waitForTimeout(300)
    await confirm.click()
    await win.waitForTimeout(800)
    const on = await win.evaluate(() => window.electronAPI.getUpdaterState())
    t.equal('confirming switches the channel to beta', on?.channel, 'beta')
    t.check(
      'confirming applies allowPrerelease and not allowDowngrade on a stable build',
      on?.flags?.allowPrerelease === true && on?.flags?.allowDowngrade === false,
      on?.flags
    )
    t.equal('the toggle now reads on', await toggle.getAttribute('aria-checked'), 'true')
    t.equal('the preference is persisted on', readPreferences(dir).prereleaseUpdates, true)

    // The beta on offer is named as one in the sidebar prompt. Settings mode
    // swaps the sidebar for its own navigation, so go back to sessions first;
    // then through the store — the seam main pushes state into — never
    // through the DOM.
    await win.getByRole('button', { name: 'Back to sessions' }).click()
    await win.waitForTimeout(500)
    await win.evaluate(() =>
      window.__claveUpdaterStoreForTests.setState({
        supported: true,
        phase: 'available',
        availableVersion: '2.0.0-beta.1',
        availableIsPrerelease: true,
        dismissed: false
      })
    )
    await win.waitForTimeout(500)
    const banner = win.locator('[data-testid="update-banner"]')
    t.equal('the update prompt appears for the beta', await banner.count(), 1)
    const bannerText = (await banner.innerText()).replace(/\s+/g, ' ')
    t.check(
      'the prompt shows the full beta version',
      bannerText.includes('v2.0.0-beta.1'),
      bannerText
    )
    // The version names the beta itself; a separate mark pushed the buttons
    // onto a second row at the sidebar's width (2026-09-22).
    t.equal(
      'the prompt carries no separate mark, the version says beta',
      await banner.locator('[data-testid="prerelease-mark"]').count(),
      0
    )

    await win.evaluate(() =>
      window.__claveUpdaterStoreForTests.setState({
        availableVersion: '1.93.0',
        availableIsPrerelease: false
      })
    )
    await win.waitForTimeout(300)
    t.equal(
      'a stable version on offer carries no mark',
      await banner.locator('[data-testid="prerelease-mark"]').count(),
      0
    )
    await win.evaluate(() =>
      window.__claveUpdaterStoreForTests.setState({
        supported: false,
        phase: 'idle',
        availableVersion: null,
        availableIsPrerelease: false
      })
    )
  } finally {
    await app.close()
  }

  // Persisted across a relaunch, and turning it off needs no confirmation.
  ;({ app, win } = await launchApp(dir))
  try {
    const state = await win.evaluate(() => window.electronAPI.getUpdaterState())
    t.equal('the channel survives a relaunch', state?.channel, 'beta')
    t.equal('so do the flags', state?.flags?.allowPrerelease, true)
    t.check('Settings opens on Software Update again', await openSoftwareUpdate(win))
    const toggle = win.getByRole('switch', { name: 'Receive pre-release builds' })
    t.equal(
      'the toggle reads on after the relaunch',
      await toggle.getAttribute('aria-checked'),
      'true'
    )
    await toggle.click()
    await win.waitForTimeout(800)
    t.equal(
      'turning it off asks nothing',
      await win.getByRole('button', { name: 'Receive Pre-releases' }).count(),
      0
    )
    const off = await win.evaluate(() => window.electronAPI.getUpdaterState())
    t.equal('turning it off returns to stable', off?.channel, 'stable')
    t.check(
      'and clears both flags on a stable build',
      off?.flags?.allowPrerelease === false && off?.flags?.allowDowngrade === false,
      off?.flags
    )
    t.equal('the preference is persisted off', readPreferences(dir).prereleaseUpdates, false)
  } finally {
    await app.close()
  }
}

// --- A beta build: named as one, allowed the way back, and its first run on
//     stable data copied aside ---
async function betaBuild(t) {
  const dir = userDataDir('updater-beta-build')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(path.join(dir, 'session-records'), { recursive: true })
  // What a stable 1.92.0 left behind, marker included.
  writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({ appIcon: 'light' }))
  writeFileSync(path.join(dir, 'session-records', 'sess-1.json'), JSON.stringify({ id: 'sess-1' }))
  writeFileSync(path.join(dir, 'last-run-version.json'), JSON.stringify({ version: '1.92.0' }))
  const args = ['--test-version=2.0.0-beta.1']
  let { app, win } = await launchApp(dir, { args })

  try {
    const state = await win.evaluate(() => window.electronAPI.getUpdaterState())
    t.equal('the build reports the pre-release version', state?.currentVersion, '2.0.0-beta.1')
    t.equal('and knows it is one', state?.currentIsPrerelease, true)
    t.equal('the channel is still what the user chose: stable', state?.channel, 'stable')
    t.check(
      'a beta build off the channel is allowed the downgrade to the current stable, and no pre-release',
      state?.flags?.allowPrerelease === false && state?.flags?.allowDowngrade === true,
      state?.flags
    )

    // The snapshot: taken before anything ran, named after the stable version.
    const snapshot = path.join(dir, 'backups', '1.92.0')
    t.equal('the state names the snapshot', state?.snapshotPath, snapshot)
    t.check(
      'the stable preferences were copied as they were',
      existsSync(path.join(snapshot, 'preferences.json')) &&
        readFileSync(path.join(snapshot, 'preferences.json'), 'utf-8') ===
          JSON.stringify({ appIcon: 'light' })
    )
    t.check(
      'the session records were copied',
      existsSync(path.join(snapshot, 'session-records', 'sess-1.json'))
    )
    // The seeded record is NOT checked here: the app's own sweep drops a
    // record with no live tmux session behind it — which is the app rewriting
    // the data after the snapshot, the very thing the snapshot is for.
    t.check(
      'the originals are still in place (copy, never move)',
      existsSync(path.join(dir, 'preferences.json'))
    )
    const marker = JSON.parse(readFileSync(path.join(dir, 'last-run-version.json'), 'utf-8'))
    t.equal('the marker now names the beta', marker.version, '2.0.0-beta.1')

    t.check('Settings opens on Software Update', await openSoftwareUpdate(win))
    const body = (await win.locator('body').innerText()).replace(/\s+/g, ' ')
    t.check(
      'the version row names the beta',
      body.includes('Clave 2.0.0-beta.1'),
      body.slice(0, 300)
    )
    const pane = win.locator('[data-settings-page="software update"]')
    const mark = pane.locator('[data-testid="prerelease-mark"]')
    t.equal('the version row carries the pre-release mark', await mark.count(), 1)
    t.check(
      'the pane says where the snapshot is',
      body.includes('Stable data snapshot') && body.includes(snapshot),
      body.slice(0, 600)
    )

    // Joining the channel from a beta build drops the downgrade; leaving it
    // brings the downgrade back. Through the IPC the toggle uses.
    const joined = await win.evaluate(() => window.electronAPI.setPrereleaseUpdates(true))
    t.check(
      'joining the channel on a beta build: pre-releases on, downgrade off',
      joined?.channel === 'beta' &&
        joined?.flags?.allowPrerelease === true &&
        joined?.flags?.allowDowngrade === false,
      joined?.flags
    )
    const left = await win.evaluate(() => window.electronAPI.setPrereleaseUpdates(false))
    t.check(
      'leaving it again: pre-releases off, downgrade back on',
      left?.channel === 'stable' &&
        left?.flags?.allowPrerelease === false &&
        left?.flags?.allowDowngrade === true,
      left?.flags
    )
  } finally {
    await app.close()
  }

  // A second beta launch on the same data takes no second snapshot.
  ;({ app, win } = await launchApp(dir, { args }))
  try {
    const state = await win.evaluate(() => window.electronAPI.getUpdaterState())
    t.equal('the second beta launch reports no new snapshot', state?.snapshotPath, null)
    t.check(
      'and backups/ still holds exactly the one',
      readdirSync(path.join(dir, 'backups')).length === 1,
      readdirSync(path.join(dir, 'backups'))
    )
  } finally {
    await app.close()
  }
}
