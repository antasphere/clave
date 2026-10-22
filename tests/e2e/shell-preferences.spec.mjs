// Shell-owned settings must reach the actual Electron consumers on every server mode.
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launchApp, userDataDir, fixturePath, REPO, openWindow, until } from './harness.mjs'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export async function run(t) {
  const dir = userDataDir('shell-preferences')
  rmSync(dir, { recursive: true, force: true })
  const modulePath = fixturePath('shell-preferences-fixture.mjs')
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/fixtures/shell-preferences.mjs')],
    outfile: modulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  })
  const { loadShellPreferences } = await import(pathToFileURL(modulePath).href)
  let launched
  const receipt = await loadShellPreferences(async ({ runId }) => {
    launched = await launchApp(dir, { args: ['--test-no-machine-usage'] })
    return { ...launched, runId }
  })
  console.log(JSON.stringify({ scenario: 'shell/preferences', runId: receipt.runId, target: dir }))
  const { app, win } = launched
  t.check(
    'the initial shell opts out of machine usage',
    await app.evaluate(() => process.argv.includes('--test-no-machine-usage'))
  )
  try {
    const second = await openWindow(app, win)
    await app.evaluate(({ app, BrowserWindow }) => {
      globalThis.__shellPreferencesPaint = []
      for (const window of BrowserWindow.getAllWindows()) {
        const original = window.setIcon.bind(window)
        window.setIcon = (image) => {
          globalThis.__shellPreferencesPaint.push({ windowId: window.id, empty: image.isEmpty() })
          return original(image)
        }
      }
      if (app.dock) {
        const original = app.dock.setIcon.bind(app.dock)
        app.dock.setIcon = (image) => {
          globalThis.__shellPreferencesPaint.push({ dock: true, empty: image.isEmpty() })
          return original(image)
        }
      }
    })
    const result = await win.evaluate(() =>
      window.electronAPI.setAppIcon('light').then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error: String(error) })
      )
    )
    t.check('the icon command succeeds on the shell', result.ok, result)
    const paint = await app.evaluate(() => globalThis.__shellPreferencesPaint)
    t.check(
      'the actual window icon was painted',
      paint.some((entry) => entry.windowId && !entry.empty),
      paint
    )
    if (process.platform === 'darwin')
      t.check(
        'the actual Dock icon was painted',
        paint.some((entry) => entry.dock && !entry.empty),
        paint
      )
    t.equal(
      'both windows received the icon',
      new Set(paint.filter((entry) => entry.windowId).map((entry) => entry.windowId)).size,
      2
    )
    const beta = await second.page.evaluate(() => window.electronAPI.setPrereleaseUpdates(true))
    t.check(
      'the actual updater allows prereleases',
      beta.flags.allowPrerelease && beta.channel === 'beta',
      beta
    )
    const sharedBeta = await win.evaluate(() => window.electronAPI.getUpdaterState())
    t.equal('another window reads the same updater channel', sharedBeta.channel, 'beta')
    await win.evaluate(() => {
      window.__shellMissionExits = 0
      window.electronAPI.onMissionControlExited(() => window.__shellMissionExits++)
    })
    await second.page.evaluate(() => window.electronAPI.missionControlSetEnabled(false))
    t.check(
      'disabling Mission Control actually hides the overlay',
      await until(() => win.evaluate(() => window.__shellMissionExits > 0))
    )
    t.equal(
      'the Mission Control consumer is disabled across windows',
      await win.evaluate(() => window.electronAPI.missionControlGetEnabled()),
      false
    )
    // Record the actual telemetry timer's callback and network boundary. No
    // public ping is sent, and no production packaging or updater path runs.
    await app.evaluate(({ app }) => {
      const packaged = Object.getOwnPropertyDescriptor(app, 'isPackaged')
      const timeout = globalThis.setTimeout
      const fetch = globalThis.fetch
      globalThis.__shellTelemetry = { requests: [], callback: null, packaged, timeout, fetch }
      Object.defineProperty(app, 'isPackaged', { configurable: true, get: () => true })
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 5000) globalThis.__shellTelemetry.callback = callback
        return timeout(callback, delay, ...args)
      }
      globalThis.fetch = async (url, options) => {
        if (String(url) === 'https://ping.clave.work/api/ping') {
          globalThis.__shellTelemetry.requests.push(JSON.parse(options.body))
          return new Response('', { status: 200 })
        }
        return fetch(url, options)
      }
    })
    try {
      await second.page.evaluate(() => window.electronAPI.telemetrySetEnabled(true))
      await app.evaluate(async ({ app }) => {
        const recording = globalThis.__shellTelemetry
        Object.defineProperty(app, 'isPackaged', recording.packaged)
        if (typeof recording.callback !== 'function')
          throw new Error('telemetry did not schedule its actual check')
        await recording.callback()
      })
      t.check(
        'the actual telemetry check uses the recorded network boundary',
        await until(() => app.evaluate(() => globalThis.__shellTelemetry.requests.length === 1))
      )
      const consent = await win.evaluate(() => window.electronAPI.telemetryGetState())
      t.check(
        'the telemetry consumer persisted its install and successful ping',
        consent.enabled && !!consent.installId && !!consent.lastPingAt,
        consent
      )
      await app.evaluate(({ app }) =>
        Object.defineProperty(app, 'isPackaged', { configurable: true, get: () => true })
      )
      await win.evaluate(() => window.electronAPI.telemetrySetEnabled(false))
      await app.evaluate(async ({ app }) => {
        const recording = globalThis.__shellTelemetry
        Object.defineProperty(app, 'isPackaged', recording.packaged)
        await recording.callback()
      })
      t.equal(
        'disabled consent prevents the actual telemetry check from sending',
        await app.evaluate(() => globalThis.__shellTelemetry.requests.length),
        1
      )
      t.equal(
        'another window reads disabled telemetry',
        (await second.page.evaluate(() => window.electronAPI.telemetryGetState())).enabled,
        false
      )
    } finally {
      await app.evaluate(({ app }) => {
        const recording = globalThis.__shellTelemetry
        Object.defineProperty(app, 'isPackaged', recording.packaged)
        globalThis.setTimeout = recording.timeout
        globalThis.fetch = recording.fetch
      })
    }
    const preferences = JSON.parse(readFileSync(path.join(dir, 'preferences.json'), 'utf8'))
    t.equal('the icon is persisted by the shell', preferences.appIcon, 'light')
    t.equal('the updater preference is persisted by the shell', preferences.prereleaseUpdates, true)
    t.equal('telemetry consent is persisted by the shell', preferences.telemetryEnabled, false)
    t.equal(
      'Mission Control is persisted by the shell',
      preferences.missionControlOverlayEnabled,
      false
    )
    await second.page.evaluate(() => window.electronAPI.setAppIcon('unknown'))
    t.equal(
      'an invalid icon cannot overwrite the shell preference',
      JSON.parse(readFileSync(path.join(dir, 'preferences.json'), 'utf8')).appIcon,
      'light'
    )
  } finally {
    await app.close()
  }
  const restored = await launchApp(dir, { args: ['--test-no-machine-usage'] })
  try {
    t.check(
      'the relaunched shell opts out of machine usage',
      await restored.app.evaluate(() => process.argv.includes('--test-no-machine-usage'))
    )
    t.equal(
      'relaunch restores the updater channel',
      (await restored.win.evaluate(() => window.electronAPI.getUpdaterState())).channel,
      'beta'
    )
    t.equal(
      'relaunch preserves disabled telemetry consent',
      (await restored.win.evaluate(() => window.electronAPI.telemetryGetState())).enabled,
      false
    )
    t.equal(
      'relaunch preserves disabled Mission Control',
      await restored.win.evaluate(() => window.electronAPI.missionControlGetEnabled()),
      false
    )
    t.check(
      'the actual startup icon reader uses the saved selection',
      readFileSync(path.join(dir, 'icon-debug.log'), 'utf8').includes(
        'applyPersistedIcon: savedIcon=light'
      )
    )
  } finally {
    await restored.app.close()
  }
}
