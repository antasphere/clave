/**
 * Creating a document and writing in it.
 *
 * A file named in the tree is a file you are about to write, so it opens BIG —
 * as a tab, the whole pane — with the caret already in it. Before this, a fresh
 * `tmp.md` landed in the 560px side sheet as a 28px editable strip with focus
 * still on the body: you typed and nothing happened anywhere.
 *
 * The focus rule is "the file is empty", not "the file is new" — so the last
 * check here is the guard on the other side: a file WITH content never steals
 * the keyboard when you open it to read.
 */
import { launchApp, seedWorkspaces, userDataDir, fixturePath } from './harness.mjs'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'

const DIR = userDataDir('new-document')
const ROOT = fixturePath('root-newdoc')
const WS = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000d1',
  name: 'Docs',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** Right-click the empty space under the last row and pick an entry. */
async function treeContextMenu(win, label) {
  const rows = await win.$$('[data-tree-item]')
  const box = await rows[rows.length - 1].boundingBox()
  await win.mouse.click(box.x + box.width / 2, box.y + box.height + 80, { button: 'right' })
  await win.waitForTimeout(500)
  await win.click(`.menu-item:has-text("${label}")`)
  await win.waitForTimeout(400)
}

export async function run(t) {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(`${ROOT}/README.md`, '# Hello\n\nsome text\n')
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })

  const { app, win } = await launchApp(DIR)
  try {
    // A session, so the tree has a cwd; then the tree.
    await win.click('.launcher-row button')
    await win.waitForTimeout(4000)
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(1200)

    await treeContextMenu(win, 'New File')
    await win.keyboard.type('tmp.md')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(1800)

    const opened = await win.evaluate(() => {
      const editable = document.querySelector('.markdown-page-content')
      const b = editable?.getBoundingClientRect()
      return {
        sheet: !!document.querySelector('.menu-surface--sheet'),
        pageEditor: !!document.querySelector('.markdown-page-editor'),
        focused: document.activeElement?.classList?.contains('markdown-page-content') ?? false,
        width: b ? Math.round(b.width) : 0
      }
    })
    t.check('the new document opens as a page editor', opened.pageEditor, opened)
    t.equal('not in the side sheet', opened.sheet, false)
    t.check('it opens big — wider than the 560px sheet', opened.width > 560, opened.width)
    t.check('the caret is already in the document', opened.focused, opened)

    // ...so typing works with no click at all.
    await win.keyboard.type('Straight in')
    await win.waitForTimeout(500)
    t.equal(
      'typing lands in the document without clicking',
      await win.evaluate(() => document.querySelector('.markdown-page-content')?.textContent),
      'Straight in'
    )

    await win.keyboard.press('Meta+s')
    await win.waitForTimeout(1500)
    t.equal('⌘S writes it to disk', readFileSync(`${ROOT}/tmp.md`, 'utf8'), 'Straight in\n')

    // A click in the page's margin belongs to the text, not to nothing.
    await win.evaluate(() => document.activeElement?.blur?.())
    const page = await win.evaluate(() => {
      const b = document.querySelector('.markdown-page-editor').getBoundingClientRect()
      return { x: b.x, y: b.y, w: b.width, h: b.height }
    })
    await win.mouse.click(page.x + page.w / 2, page.y + page.h - 20)
    await win.waitForTimeout(400)
    t.check(
      'clicking the empty page below the text puts the caret back in it',
      await win.evaluate(
        () => document.activeElement?.classList?.contains('markdown-page-content') ?? false
      ),
      await win.evaluate(() => document.activeElement?.className ?? document.activeElement?.tagName)
    )

    // The same for a code file: a new .txt opens in the editor, caret in it.
    await treeContextMenu(win, 'New File')
    await win.keyboard.type('notes.txt')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(1800)
    t.check(
      'a new code file opens with the caret in the editor',
      await win.evaluate(() => document.activeElement?.classList?.contains('cm-content') ?? false),
      await win.evaluate(() => document.activeElement?.className ?? document.activeElement?.tagName)
    )
    await win.keyboard.type('plain text')
    await win.keyboard.press('Meta+s')
    await win.waitForTimeout(1500)
    t.equal('and ⌘S writes that one too', readFileSync(`${ROOT}/notes.txt`, 'utf8'), 'plain text')

    // The guard: a file that already has content does NOT grab the keyboard.
    await win.evaluate(() => document.activeElement?.blur?.())
    await win.dblclick('[data-tree-item]:has-text("README.md")')
    await win.waitForTimeout(1500)
    t.equal(
      'opening a file that has content leaves focus alone',
      await win.evaluate(
        () => document.activeElement?.classList?.contains('markdown-page-content') ?? false
      ),
      false
    )
  } finally {
    await app.close()
  }
}
