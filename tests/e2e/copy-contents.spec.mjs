/**
 * The copy button on a file copies the FILE, not its name.
 *
 * Both file surfaces — the 560px preview sheet and the full file tab — carried
 * a copy button that put the path on the clipboard, which is the one thing the
 * tree's own right-click menu already offers twice ("Copy Relative Path",
 * "Copy Absolute Path"). Opening a document and pressing copy has exactly one
 * meaning; this spec is what holds it to that.
 *
 * The assertions read the MAIN process clipboard, so they see what actually
 * landed on the pasteboard rather than what the renderer believes it wrote.
 */
import { launchApp, seedWorkspaces, userDataDir, fixturePath } from './harness.mjs'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const DIR = userDataDir('copy-contents')
const ROOT = fixturePath('root-copy')
const BODY = '# Notes\n\nthe body of the file, not its name\n'
const WS = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000e1',
  name: 'Copy',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** Read the real pasteboard from the main process. */
const readClipboard = (app) => app.evaluate(({ clipboard }) => clipboard.readText())
const clearClipboard = (app) =>
  app.evaluate(({ clipboard }) => clipboard.writeText('__not-copied-yet__'))

export async function run(t) {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(`${ROOT}/notes.md`, BODY)
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })

  const { app, win } = await launchApp(DIR)
  try {
    // A session, so the tree has a cwd; then the tree.
    await win.click('.launcher-row button')
    await win.waitForTimeout(4000)
    // Prefix match: the tooltip now carries the user's own binding for the panel.
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(1200)

    // --- The preview sheet ---
    await win.dblclick('[data-tree-item]:has-text("notes.md")')
    await win.waitForTimeout(1500)
    t.check(
      'double-clicking the file opens the preview sheet',
      await win.evaluate(() => !!document.querySelector('.menu-surface--sheet')),
      await win.evaluate(() => document.body.innerHTML.slice(0, 400))
    )

    // Copy contents is a row of the bar's ⋯ menu (PRDCT-4491), the menu drawn
    // in a portal outside the sheet.
    const copyFromMenu = async (bar) => {
      await win.click(`${bar} button[aria-label="File menu"]`)
      await win.locator('[role="menuitem"]', { hasText: 'Copy contents' }).click()
    }
    const menuGone = () =>
      win
        .locator('[role="menu"]')
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => {})

    await clearClipboard(app)
    await copyFromMenu('.menu-surface--sheet')
    await win.waitForTimeout(400)
    const fromSheet = await readClipboard(app)
    t.equal('the sheet’s menu copies the file body', fromSheet, BODY)
    t.check(
      'and not the path the tree menu already copies',
      fromSheet !== './notes.md' && fromSheet !== `${ROOT}/notes.md`,
      fromSheet
    )
    t.check(
      'the row says so before the menu closes',
      (await win.locator('[role="menuitem"]', { hasText: 'Copied' }).count()) === 1,
      await win.evaluate(() => document.querySelector('[role="menu"]')?.textContent ?? 'no menu')
    )
    await menuGone()

    // --- The file tab ---
    await win.click('.menu-surface--sheet button[title="Open in tab"]')
    await win.waitForTimeout(2000)

    await clearClipboard(app)
    await copyFromMenu('.pane-header:visible')
    await win.waitForTimeout(400)
    const fromTab = await readClipboard(app)
    t.equal('the file tab’s menu copies the file body too', fromTab, BODY)
    await menuGone()

    // --- It copies what you are looking at, unsaved edits included ---
    await win.click('.cm-content, .markdown-page-content')
    await win.waitForTimeout(300)
    await win.keyboard.type('EDITED ')
    await win.waitForTimeout(600)
    await clearClipboard(app)
    await copyFromMenu('.pane-header:visible')
    await win.waitForTimeout(400)
    const dirty = await readClipboard(app)
    t.check('an unsaved edit is in what gets copied', dirty.includes('EDITED'), dirty)
  } finally {
    await app.close()
  }
}
