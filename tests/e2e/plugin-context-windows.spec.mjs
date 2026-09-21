// The focused session a plugin is told about, across two windows.
//
// Focus is a renderer fact, so each window reports its own and the most recent report wins.
// The failure this spec exists for is the quiet one: close the window you were last focused
// in, and a plugin allowed to read sessions goes on being told that window's tab is the one
// in front of the user — and the answer looks perfectly valid, because a session outlives
// the window it was opened in and its id still resolves. Adopted from the round-1 verifier's
// reproduction, which found the hole by reading the code.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, seedWorkspaces, until, callMcp, openWindow, closeWindow } from './harness.mjs'

export async function run(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clave-plugin-context-windows-'))
  const dir = path.join(root, 'profile')
  const alpha = path.join(root, 'alpha-repo')
  const beta = path.join(root, 'beta-repo')
  mkdirSync(alpha)
  mkdirSync(beta)
  seedWorkspaces(dir, { workspaces: [], activeWorkspaceId: null })
  const tmuxDir = path.join(root, 'tmux')
  mkdirSync(tmuxDir)
  const { app, win } = await launchApp(dir, { env: { TMUX_TMPDIR: tmuxDir } })
  let alphaSession
  let betaSession
  try {
    // The plugin answers with what the host pushed it, so asking is one click and the answer
    // is a notification on its record. The record keeps the LAST notification, so a reader
    // that only waits for the title reads the previous answer: every ask after the first
    // waits for the body to change, which is the thing under test anyway.
    const ask = async (page, previous) => {
      await page.click('[data-plugin-toolbar="hello-menu"]')
      // The menu is animated, and on a loaded machine its box is still settling when
      // Playwright's stability check gives up — that is the animation failing, not the
      // wiring this spec is about. Wait for the item, then click it regardless.
      const item = page.locator('[data-plugin-toolbar-item="pushed-context"]')
      await item.waitFor({ state: 'visible' })
      await item.click({ force: true })
      return until(async () => {
        const record = (await page.evaluate(() => window.electronAPI.pluginsList())).find(
          (p) => p.id === 'clave.hello'
        )
        if (record?.lastNotification?.title !== 'Pushed context') return null
        const body = record.lastNotification.body
        return body !== previous ? body : null
      })
    }

    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.click('[data-settings-nav-row="plugins"]')
    await win.getByRole('switch', { name: 'Enable Hello Clave', exact: true }).click()
    await win.getByRole('button', { name: 'Enable plugin', exact: true }).click()
    t.check(
      'the demo is enabled in the first window',
      !!(await until(async () =>
        (await win.evaluate(() => window.electronAPI.pluginsList())).find(
          (p) => p.id === 'clave.hello' && p.status === 'active'
        )
      ))
    )

    const first = await callMcp(app, 'openSession', {
      cwd: alpha,
      mode: 'terminal',
      name: 'Alpha tab'
    })
    alphaSession = first.sessionId
    const onAlpha = await ask(win)
    t.equal('the plugin is told the first window’s tab', onAlpha, `alpha-repo (${alphaSession})`)

    // A second window, opened the way the File menu opens one.
    const second = await openWindow(app, win)
    const secondPage = second.page
    const secondId = await (await app.browserWindow(secondPage)).evaluate((w) => w.id)
    const other = await callMcp(
      app,
      'openSession',
      { cwd: beta, mode: 'terminal', name: 'Beta tab' },
      10_000,
      secondId
    )
    betaSession = other.sessionId
    const onBeta = await ask(win, onAlpha)
    t.equal(
      'focus moving to the second window moves what the plugin is told',
      onBeta,
      `beta-repo (${betaSession})`
    )

    // The window goes away. Its session does not: sessions are adopted by the primary
    // window, so the id still resolves and a stale answer would look entirely valid.
    await closeWindow(app, secondPage)
    const after = await ask(win, onBeta)
    t.check(
      // `after` is null when the answer never changed, which is exactly what a stale
      // report looks like from here — so the check has to insist on an answer, not merely
      // on the absence of the old one.
      'the closed window’s session is no longer reported as focused',
      after !== null && after !== `beta-repo (${betaSession})`,
      { after, closedWindowSession: `beta-repo (${betaSession})` }
    )
    t.equal(
      'and the plugin is told there is no focused tab rather than a stale one',
      after,
      'no focused session'
    )
  } finally {
    try {
      for (const id of [alphaSession, betaSession].filter(Boolean)) {
        await win.evaluate((s) => window.electronAPI.killSession(s), id).catch(() => {})
      }
    } finally {
      await app.close()
    }
    rmSync(root, { recursive: true, force: true })
  }
}
