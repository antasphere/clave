// A plugin configures the app's own chrome: a side-panel tab beside Files and Git, a
// button and a popover in the toolbar, a panel in the main area, and the focused session
// pushed to the plugin process. Every assertion here is about what the user can click,
// in the real Electron app — the failure mode of all of this is silence (an unread
// manifest field renders nothing and reports nothing), so the checks are on the DOM and
// on what the plugin actually received, never on the manifest being well-formed.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, seedWorkspaces, until, callMcp } from './harness.mjs'

export async function run(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clave-plugin-surfaces-'))
  const dir = path.join(root, 'profile')
  const folder = path.join(root, 'hello-repo')
  mkdirSync(folder)
  seedWorkspaces(dir, { workspaces: [], activeWorkspaceId: null })
  const tmuxDir = path.join(root, 'tmux')
  mkdirSync(tmuxDir)
  const { app, win } = await launchApp(dir, { env: { TMUX_TMPDIR: tmuxDir } })
  let sessionId
  try {
    const record = async (id = 'clave.hello') =>
      (await win.evaluate(() => window.electronAPI.pluginsList())).find((p) => p.id === id)
    const notification = async (title) =>
      until(async () => {
        const last = (await record())?.lastNotification
        return last?.title === title ? last : null
      })

    // A fresh profile shows the app's own panel and nothing else: the bundled demo ships
    // disabled, so no plugin touches the chrome until the user says so in Settings.
    await win.click('button[title^="File tree"]')
    await win.waitForSelector('[data-panel-bar="tabs"]')
    t.equal(
      'a fresh profile has no contributed tab',
      await win.locator('[data-plugin-tab]').count(),
      0
    )
    t.equal(
      'and the panel holds only the app’s own two tabs',
      (await win.locator('[data-panel-bar="tabs"] .panel-tab').allInnerTexts()).join(','),
      'Files,Git'
    )
    t.equal(
      'and nothing plugin-contributed is in the toolbar',
      await win.locator('[data-plugin-toolbar], [data-plugin-main-toggle]').count(),
      0
    )

    // Enable it the way a user does: Settings → Plugins, the review, the switch.
    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.click('[data-settings-nav-row="plugins"]')
    await win.getByRole('switch', { name: 'Enable Hello Clave', exact: true }).click()
    await win.getByRole('button', { name: 'Enable plugin', exact: true }).click()
    const hello = await until(async () => {
      const found = await record()
      return found?.status === 'active' ? found : null
    })
    t.check('the demo activates once enabled with its contributions', !!hello, hello)
    t.equal('side panel contribution is registered', hello.panels.includes('hello'), true)
    t.check(
      'toolbar contributions are registered through ui.registerToolbar',
      hello.toolbar.includes('wave') && hello.toolbar.includes('hello-menu'),
      hello.toolbar
    )

    // The terminal the user is looking at — the context the plugin must receive.
    const terminal = await callMcp(app, 'openSession', {
      cwd: folder,
      mode: 'terminal',
      name: 'Plugin context target'
    })
    sessionId = terminal.sessionId

    // 1. The toolbar action: one button, running the plugin's command of the same id.
    await win.click('[data-plugin-toolbar="wave"]')
    t.check(
      'a toolbar action runs the plugin command of the same id',
      !!(await notification('Wave from the toolbar'))
    )

    // 2. The popover: a menu surface of items, each one a command.
    await win.click('[data-plugin-toolbar="hello-menu"]')
    await win.waitForSelector('[data-plugin-toolbar-menu="hello-menu"]')
    t.equal(
      'the popover lists every declared item',
      await win.locator('[data-plugin-toolbar-menu="hello-menu"] [data-plugin-toolbar-item]').count(),
      3
    )
    await win.click('[data-plugin-toolbar-item="say-hello"]')
    t.check('a popover item runs its command', !!(await notification('Hello from Clave')))

    // 3. The focused session reaches the plugin process, pushed and pulled.
    await win.click('[data-plugin-toolbar="hello-menu"]')
    await win.click('[data-plugin-toolbar-item="pushed-context"]')
    const pushed = await notification('Pushed context')
    t.check(
      'context.changed pushed the focused session to the plugin',
      pushed?.body === `hello-repo (${sessionId})`,
      pushed
    )
    await win.click('[data-plugin-toolbar="hello-menu"]')
    await win.click('[data-plugin-toolbar-item="focused-session"]')
    const pulled = await notification('Focused session')
    t.check(
      'sessions.focused answers with the same session',
      pulled?.body === `hello-repo (${sessionId})`,
      pulled
    )

    // 4. The side panel: a tab beside Files and Git, rendering the plugin's own surface.
    // The tab bar mounts before the plugin records reach the renderer, so wait for the
    // contribution itself rather than for the bar that will hold it.
    await win.waitForSelector('[data-plugin-tab="hello"]')
    // A main-placement panel is not a tab here: the placement is the whole difference
    // between the two hosts, and reading it wrong shows up as an extra tab, nothing else.
    t.equal(
      'only the side-placement panel becomes a tab',
      await win.locator('[data-plugin-tab]').count(),
      1
    )
    t.equal(
      'a main panel is not a side-panel tab',
      await win.locator('[data-plugin-tab="hello-main"]').count(),
      0
    )
    // The app's two tabs filled most of a 240px bar on their own; a contributed tab is
    // what would have wrapped it onto a second row.
    const bar = await win.evaluate(() => {
      const el = document.querySelector('[data-panel-bar="tabs"]')
      const box = el.getBoundingClientRect()
      return {
        width: box.width,
        parentWidth: el.parentElement.getBoundingClientRect().width,
        rows: Math.round(box.height / el.querySelector('.panel-tab').getBoundingClientRect().height)
      }
    })
    t.check(
      'the bar takes the contributed tab without outgrowing the panel or wrapping',
      bar.width <= bar.parentWidth && bar.rows === 1,
      bar
    )
    t.equal(
      'the panel contributes a tab, titled and iconed from the manifest',
      await win.locator('[data-plugin-tab="hello"]').innerText(),
      'Hello panel'
    )
    await win.click('[data-plugin-tab="hello"]')
    await win.waitForSelector('[data-plugin-side-panel="hello"] webview')
    const guestSurface = () =>
      win.evaluate(async () => {
        const view = document.querySelector('[data-plugin-side-panel="hello"] webview')
        try {
          return await view.executeJavaScript(
            'getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim()'
          )
        } catch {
          return null
        }
      })
    const hostSurface = await win.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim()
    )
    t.check(
      'the side-panel surface is themed like the app it sits in',
      await until(async () => (await guestSurface()) === hostSurface),
      { hostSurface, guestSurface: await guestSurface() }
    )
    t.equal(
      'the folder bar, which is about Files and Git, steps aside',
      await win.locator('[data-panel-bar="path"]').count(),
      0
    )
    await win.click('[data-panel-bar="tabs"] button:has-text("Files")')
    t.equal(
      'Files takes the panel back',
      await win.locator('[data-plugin-side-panel="hello"]').count(),
      0
    )

    // 5. The main placement: the content column, not the side panel.
    await win.click('[data-plugin-main-toggle="hello-main"]')
    await win.waitForSelector('[data-plugin-main-panel="hello-main"] webview')
    await win.click('[data-plugin-main-toggle="hello-main"]')
    t.equal(
      'the toolbar toggle closes it again',
      await win.locator('[data-plugin-main-panel]').count(),
      0
    )

    // 6. Disabling the plugin takes every surface with it: a contribution outliving its
    //    plugin would render a revoked URL and a button that answers nothing.
    await win.click('[data-plugin-tab="hello"]')
    await win.waitForSelector('[data-plugin-side-panel="hello"] webview')
    await win.evaluate(() => window.electronAPI.pluginsDisable('clave.hello'))
    t.check(
      'disabling removes the tab, the surface and the toolbar entries',
      await until(
        async () =>
          (await win.locator('[data-plugin-tab]').count()) === 0 &&
          (await win.locator('[data-plugin-side-panel]').count()) === 0 &&
          (await win.locator('[data-plugin-toolbar]').count()) === 0 &&
          (await win.locator('[data-plugin-main-toggle]').count()) === 0
      ),
      {
        tabs: await win.locator('[data-plugin-tab]').count(),
        toolbar: await win.locator('[data-plugin-toolbar]').count()
      }
    )
    t.equal(
      'the panel falls back to Files rather than an empty pane',
      await win.locator('[data-panel-bar="path"]').count(),
      1
    )
  } finally {
    try {
      if (sessionId) await win.evaluate((id) => window.electronAPI.killSession(id), sessionId)
    } finally {
      await app.close()
    }
    rmSync(root, { recursive: true, force: true })
  }
}
