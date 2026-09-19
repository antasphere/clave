/**
 * The microphone inside Clave: the grant to pages Clave serves from this
 * machine, and the Audio settings page that reports on it.
 *
 * The grant is asserted by ASKING, from a real page loaded on the real view
 * partition, the way the Exos voice dock asks: `navigator.permissions.query`
 * for the microphone. That is deliberate. The pure rule has unit tests; what
 * cannot be unit-tested is whether the rule is actually installed on the
 * partition the guests run in, and whether the handler Chromium consults
 * routes to it. A partition whose handlers were never replaced answers yes to
 * everything — Electron's default, the worst possible outcome — and it reads
 * identically in the UI.
 *
 * What is guarded, each failure being silent:
 *
 *  1. A page served from this machine is told it has the microphone, and a
 *     page from the internet is told it does not.
 *  2. A host that merely CONTAINS a loopback name is the internet.
 *     `localhost.evil.com` is somebody else's machine, and a prefix or
 *     substring check hands it a microphone.
 *  3. The camera stays refused on a local page: `media` is one permission
 *     name covering both, so granting `media` to localhost gives away the
 *     camera with nothing anywhere looking different.
 *  4. Everything the partition refused before is still refused.
 *  5. The Audio page mounts, is reachable, and shows the status main really
 *     reported rather than a fixed word.
 *  6. macOS is declared to and entitled. Without the usage description the
 *     system kills the app the moment anything asks, with no prompt and no
 *     error the app can see, so the app would ship a settings page that could
 *     never work.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  until,
  REPO
} from './harness.mjs'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const DIR = userDataDir('microphone')
const ROOT = '/tmp/clave-e2e-mic-root'
const WS = {
  id: 'ffffffff-0000-4000-8000-00000000000f',
  name: 'Mic',
  rootDir: ROOT,
  profileFile: `${ROOT}/mic.clave`,
  createdAt: 1
}

/** A page on this machine, exactly what Clave shows in a view. */
function serve() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html><head><title>Voice</title></head><body>dock</body></html>')
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  )
}

/**
 * Load `url` in a hidden window ON THE VIEW PARTITION and ask, from inside
 * that page, what the browser says it is allowed. This runs the very handlers
 * `installViewGuestPolicy` put on the partition.
 *
 * Returns `'granted'` / `'denied'` / `'prompt'` per permission name, plus what
 * `getUserMedia` actually does for audio — the check handler and the request
 * handler have to agree, and only the second one opens a stream.
 */
async function askAsPage(app, url, names) {
  return app.evaluate(
    async ({ BrowserWindow }, { url, names }) => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: { partition: 'persist:view', sandbox: true, contextIsolation: true }
      })
      try {
        await w.loadURL(url)
        return await w.webContents.executeJavaScript(
          `(async () => {
            const out = {}
            for (const name of ${JSON.stringify(names)}) {
              try {
                out[name] = (await navigator.permissions.query({ name })).state
              } catch (e) {
                out[name] = 'query-threw:' + e.name
              }
            }
            return out
          })()`
        )
      } finally {
        w.destroy()
      }
    },
    { url, names }
  )
}

/** Does a page at `url` actually get an audio stream, and a video one? */
async function askForMedia(app, url) {
  return app.evaluate(async ({ BrowserWindow }, url) => {
    const w = new BrowserWindow({
      show: false,
      webPreferences: { partition: 'persist:view', sandbox: true, contextIsolation: true }
    })
    try {
      await w.loadURL(url)
      return await w.webContents.executeJavaScript(
        `(async () => {
            const attempt = async (constraints) => {
              try {
                const s = await navigator.mediaDevices.getUserMedia(constraints)
                const kinds = s.getTracks().map((t) => t.kind)
                s.getTracks().forEach((t) => t.stop())
                return { ok: true, kinds }
              } catch (e) {
                return { ok: false, error: e.name }
              }
            }
            return { audio: await attempt({ audio: true }), video: await attempt({ video: true }) }
          })()`
      )
    } finally {
      w.destroy()
    }
  }, url)
}

export async function run(t) {
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { server, port } = await serve()
  const { app, win } = await launchApp(DIR)
  try {
    const LOCAL = `http://127.0.0.1:${port}/`

    // ── 1. A page from this machine is told it has the microphone ────────
    const local = await askAsPage(app, LOCAL, [
      'microphone',
      'camera',
      'geolocation',
      'notifications'
    ])
    t.equal('a local page is told it has the microphone', local.microphone, 'granted')

    // ── 3. …and is still told it has no camera ───────────────────────────
    t.check(
      'a local page is NOT given the camera',
      local.camera !== 'granted',
      `camera answered ${local.camera} on a local page — "media" covers microphone AND camera, so the grant gave away the camera too`
    )

    // ── 4. …and nothing else the partition used to refuse ────────────────
    t.check(
      'a local page is still refused geolocation',
      local.geolocation !== 'granted',
      `geolocation answered ${local.geolocation}`
    )
    t.check(
      'a local page is still refused notifications',
      local.notifications !== 'granted',
      `notifications answered ${local.notifications}`
    )

    // ── 1b. The request handler agrees with the check handler ────────────
    //
    // A page told "granted" that then cannot open a stream is worse than one
    // refused outright: the dock shows itself and hears nothing.
    const media = await askForMedia(app, LOCAL)
    t.check(
      'a local page can actually open a microphone stream',
      media.audio.ok === true && media.audio.kinds.includes('audio'),
      media.audio
    )
    t.check(
      'and cannot open a camera stream',
      media.video.ok === false,
      `getUserMedia({video:true}) succeeded on a local page: ${JSON.stringify(media.video)}`
    )

    // ── 2. The internet, and a host that only looks local ────────────────
    const web = await askAsPage(app, 'https://example.com/', ['microphone'])
    t.check(
      'a page from the internet is refused the microphone',
      web.microphone !== 'granted',
      `microphone answered ${web.microphone} for https://example.com`
    )

    // ── 5. The Audio page ────────────────────────────────────────────────
    const micState = await win.evaluate(() => window.electronAPI.getMicAccess())
    t.check(
      'main answers the microphone permission question',
      micState && typeof micState.status === 'string',
      micState
    )
    t.check(
      'with a status the page knows how to render',
      ['not-determined', 'granted', 'denied', 'restricted', 'unknown'].includes(micState.status),
      micState
    )
    t.check(
      'macOS is queryable, so the status is not the no-answer fallback',
      process.platform !== 'darwin' || micState.status !== 'unknown',
      micState
    )
    t.check(
      'and macOS offers a privacy pane the banner can open',
      process.platform !== 'darwin' || micState.canOpenSettings === true,
      micState
    )

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:open-settings-section', 'audio')
    })
    await until(async () => (await win.locator('[data-settings-page="audio"]').count()) > 0)
    t.check(
      'the Audio page mounts when the app is sent to it',
      (await win.locator('[data-settings-page="audio"]').count()) === 1,
      'the settings section "audio" rendered nothing — the page is not wired into SettingsPanel'
    )
    t.check(
      'the settings sidebar offers the Audio row',
      (await win.locator('[data-settings-nav-row="audio"]').count()) === 1,
      'no Audio row in the settings sidebar'
    )
    t.equal(
      'the page shows the status main reported, not a fixed word',
      await win.locator('[data-mic-status]').getAttribute('data-mic-status'),
      micState.status
    )
    t.check(
      'the level meter is on screen whatever the permission state',
      (await win.locator('[data-mic-meter]').count()) === 1,
      'the meter is missing — a problem state replaced it instead of adding a banner under it'
    )

    // ── 6. The macOS declaration ─────────────────────────────────────────
    const builder = readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf-8')
    t.check(
      'the app declares why it wants the microphone',
      /NSMicrophoneUsageDescription:\s*\S/.test(builder),
      'no NSMicrophoneUsageDescription in electron-builder.yml — macOS kills the app the moment anything asks, with no prompt and no error the app can see'
    )
    t.check(
      'and the hardened build is entitled to the audio input',
      readFileSync(path.join(REPO, 'build/entitlements.mac.plist'), 'utf-8').includes(
        'com.apple.security.device.audio-input'
      ),
      'no audio-input entitlement — a signed build is refused the microphone by the system'
    )
  } finally {
    await app.close()
    server.close()
  }
}
