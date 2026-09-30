/**
 * Right-clicking a session tab offers its id.
 *
 * "Copy session ID" puts the tab's Clave id on the clipboard — the string an
 * agent hands to a clave_* tool, a `.clave` names, a bug report quotes. A tab
 * that also carries its provider's own id (the transcript `claude --resume`
 * takes) gets a second, named entry for that one, because the two strings
 * differ and only one of them resumes a conversation.
 *
 * The assertions read the MAIN process clipboard, so they see what landed on
 * the pasteboard rather than what the renderer believes it wrote.
 */
import { launchApp, seedWorkspaces, userDataDir, fixturePath } from './harness.mjs'
import { mkdirSync, rmSync } from 'node:fs'

const DIR = userDataDir('copy-session-id')
const ROOT = fixturePath('root-copy-session-id')
const WS = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000e2',
  name: 'CopyId',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const CLAUDE_ID = 'e2e-claude-0001'

const readClipboard = (app) => app.evaluate(({ clipboard }) => clipboard.readText())
const clearClipboard = (app) =>
  app.evaluate(({ clipboard }) => clipboard.writeText('__not-copied-yet__'))
const menuLabels = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('.menu-surface .menu-item')].map(
      (el) => el.textContent?.trim() ?? ''
    )
  )

export async function run(t) {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })

  const { app, win } = await launchApp(DIR)
  try {
    // A plain terminal: the menu must not depend on a provider being installed.
    await win.click('.launcher-row button')
    await win.waitForTimeout(3000)
    const sessions = await win.evaluate(() => window.electronAPI.sessionsList())
    t.equal('one session exists after launching a terminal', sessions.length, 1)
    const sessionId = sessions[0].id
    const row = `[data-sidebar-item-id="${sessionId}"]`
    await win.waitForSelector(row, { timeout: 5000 })

    // --- The Clave id ---
    await win.click(row, { button: 'right' })
    await win.waitForTimeout(350)
    const labels = await menuLabels(win)
    t.check(
      'the session menu carries "Copy session ID"',
      labels.includes('Copy session ID'),
      labels
    )
    t.check(
      'a tab without a provider id offers no provider entry',
      !labels.some((l) => /^Copy (Claude|Pi) session ID$/.test(l)),
      labels
    )
    await clearClipboard(app)
    await win.locator('.menu-surface .menu-item', { hasText: /^Copy session ID$/ }).click()
    await win.waitForTimeout(400)
    t.equal(
      '"Copy session ID" puts the tab’s Clave id on the pasteboard',
      await readClipboard(app),
      sessionId
    )

    // --- The provider id, once the tab has one ---
    await app.evaluate(
      ({ BrowserWindow }, { id, stem }) => {
        BrowserWindow.getAllWindows()[0].webContents.send(`session:clear-detected:${id}`, stem)
      },
      { id: sessionId, stem: CLAUDE_ID }
    )
    await win.waitForTimeout(400)
    await win.click(row, { button: 'right' })
    await win.waitForTimeout(350)
    const withProvider = await menuLabels(win)
    t.check(
      'a tab with a Claude id offers "Copy Claude session ID"',
      withProvider.includes('Copy Claude session ID'),
      withProvider
    )
    await clearClipboard(app)
    await win.locator('.menu-surface .menu-item', { hasText: /^Copy Claude session ID$/ }).click()
    await win.waitForTimeout(400)
    const copied = await readClipboard(app)
    t.equal('it copies the Claude id, not the Clave one', copied, CLAUDE_ID)
    t.check('the two ids are different strings', copied !== sessionId, { copied, sessionId })
  } finally {
    await app.close()
  }
}
