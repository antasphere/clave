/**
 * A middle click on a sidebar row closes it, the way a browser tab closes.
 *
 * It takes the X button's path, not a shortcut past it: a session row still
 * asks "Delete session" first, and Cancel keeps the session. The middle
 * button arrives as `auxclick` — it never reaches `click` — so a handler on
 * the wrong event would leave the row selected and the session alive, which is
 * exactly what the first assertion catches.
 */
import { launchApp, seedWorkspaces, userDataDir, fixturePath, until } from './harness.mjs'
import { mkdirSync, rmSync } from 'node:fs'

const DIR = userDataDir('middle-click-close')
const ROOT = fixturePath('root-middle-click-close')
const WS = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000e3',
  name: 'MiddleClose',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const dialogTitle = (win) =>
  win.evaluate(() => document.querySelector('.modal-card h2')?.textContent?.trim() ?? null)
const dialogButton = (win, label) =>
  win.locator('.modal-card button.btn-dialog', { hasText: new RegExp(`^${label}$`) })
const sessionCount = (win) =>
  win.evaluate(() => window.electronAPI.sessionsList().then((s) => s.length))

export async function run(t) {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })

  const { app, win } = await launchApp(DIR)
  try {
    // A plain terminal: the row must not depend on a provider being installed.
    await win.click('.launcher-row button')
    await win.waitForTimeout(3000)
    const sessions = await win.evaluate(() => window.electronAPI.sessionsList())
    t.equal('one session exists after launching a terminal', sessions.length, 1)
    const sessionId = sessions[0].id
    const row = `[data-sidebar-item-id="${sessionId}"] button.sidebar-item`
    await win.waitForSelector(row, { timeout: 5000 })
    t.equal('no dialog is open before the click', await dialogTitle(win), null)

    // --- Middle click asks, Cancel keeps ---
    await win.click(row, { button: 'middle' })
    await win.waitForTimeout(350)
    t.equal(
      'a middle click on the row opens the "Delete session" dialog',
      await dialogTitle(win),
      'Delete session'
    )
    await dialogButton(win, 'Cancel').click()
    await win.waitForTimeout(350)
    t.equal('Cancel closes the dialog', await dialogTitle(win), null)
    t.equal('Cancel keeps the session', await sessionCount(win), 1)
    t.check('the row is still in the sidebar after Cancel', (await win.$(row)) !== null)

    // --- Middle click asks, Delete closes ---
    await win.click(row, { button: 'middle' })
    await win.waitForTimeout(350)
    t.equal('a second middle click asks again', await dialogTitle(win), 'Delete session')
    await dialogButton(win, 'Delete').click()
    const gone = await until(async () => ((await sessionCount(win)) === 0 ? true : null))
    t.check('confirming removes the session', gone === true)
    t.check('the row left the sidebar', (await win.$(row)) === null)
  } finally {
    await app.close()
  }
}
