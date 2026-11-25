import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launchApp, serverDataDirOf, until, userDataDir } from './harness.mjs'

// Settings → Writing styles on this Mac (PRDCT-5166): a built-in style offers
// no Edit; a style made on the page and picked as the default is written to
// the document the host keeps (`writing-styles.json` in the data folder of
// the process that holds the settings, whichever server mode), and a
// relaunch lists it still, still the default. What is asserted is the file
// on disk and the page read back after the relaunch, never the page's own
// state alone.

const NAME = 'Field notes'
const ID = 'field-notes'
const TEXT = 'Write in short field notes, one line each.'

async function openStyles(win) {
  await win.locator('.sidebar-footer-btn[aria-label="Settings"]').click()
  await win.locator('[data-settings-nav-row="styles"]').click()
  const page = win.locator('[data-settings-page="styles"]')
  await page.waitFor()
  await page.locator('[data-writing-style-row="brief"]').waitFor()
  return page
}

/** Pick an option of a settings select; the menu animates in, so the open is waited for. */
async function pick(win, select, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await select.click()
    const item = win.getByRole('menuitem', { name })
    const offered = await item.waitFor({ state: 'visible', timeout: 1500 }).then(
      () => true,
      () => false
    )
    if (offered) {
      await item.click({ timeout: 3000 }).catch(() => undefined)
      return
    }
    await win.keyboard.press('Escape')
  }
  throw new Error(`the select never offered ${String(name)}`)
}

function storedDocument(dir) {
  const file = path.join(serverDataDirOf(dir), 'writing-styles.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

export async function run(t) {
  const dir = userDataDir('settings-writing-styles')
  rmSync(dir, { recursive: true, force: true })
  let launched = await launchApp(dir)
  try {
    let page = await openStyles(launched.win)

    // ── A built-in style is read-only: View and Duplicate, no Edit, no Delete ──
    t.equal(
      'the built-in Brief offers no Edit',
      await page.locator('[data-testid="writing-style-edit-brief"]').count(),
      0
    )
    t.equal(
      'the built-in Brief offers no Delete',
      await page.locator('[data-testid="writing-style-delete-brief"]').count(),
      0
    )
    t.equal(
      'the built-in Brief offers View',
      await page.locator('[data-testid="writing-style-view-brief"]').count(),
      1
    )
    t.equal('a fresh machine keeps no document yet', storedDocument(dir), null)

    // ── A style made on the page ──
    await page.locator('[data-testid="writing-style-new"]').click()
    await page.locator('[data-testid="writing-style-name"]').fill(NAME)
    await page.locator('[data-testid="writing-style-description"]').fill('For a quiet lane.')
    await page.locator('[data-testid="writing-style-text"]').fill(TEXT)
    await page.locator('[data-testid="writing-style-save"]').click()
    await page.locator(`[data-writing-style-row="${ID}"]`).waitFor()
    t.check(
      'the new style offers Edit and Delete',
      (await page.locator(`[data-testid="writing-style-edit-${ID}"]`).count()) === 1 &&
        (await page.locator(`[data-testid="writing-style-delete-${ID}"]`).count()) === 1
    )

    // ── Picked as the default ──
    const select = page.locator('[data-settings-select="writing-styles-default"]')
    t.equal('new tabs start with no style', await select.getAttribute('data-value'), 'none')
    await pick(launched.win, select, NAME)
    await until(async () => (await select.getAttribute('data-value')) === ID)
    t.equal('the select shows the pick', await select.getAttribute('data-value'), ID)

    // ── The document the host wrote ──
    await until(async () => storedDocument(dir)?.defaultStyleId === ID)
    const stored = storedDocument(dir)
    t.equal('the document names the default', stored?.defaultStyleId, ID)
    // `t.equal` is `Object.is`: the list is compared as its JSON.
    t.equal(
      'the document keeps the style, and no built-in one',
      JSON.stringify(stored?.styles),
      JSON.stringify([
        { id: ID, name: NAME, description: 'For a quiet lane.', text: TEXT, statusCard: false }
      ])
    )

    // ── A relaunch lists it still, still the default ──
    await launched.app.close()
    launched = await launchApp(dir)
    page = await openStyles(launched.win)
    await page.locator(`[data-writing-style-row="${ID}"]`).waitFor()
    t.equal(
      'after a relaunch the style is listed',
      await page.locator(`[data-writing-style-row="${ID}"]`).count(),
      1
    )
    t.equal(
      'after a relaunch it is still the default',
      await page
        .locator('[data-settings-select="writing-styles-default"]')
        .getAttribute('data-value'),
      ID
    )
  } finally {
    await launched.app.close()
  }
}
