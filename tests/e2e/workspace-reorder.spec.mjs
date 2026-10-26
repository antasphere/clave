// Workspaces reorder by drag (#257): in the toolbar switcher and in
// Settings → Workspaces. The order is the registry's own order, so a drag
// must reach the authoritative registry (the server's, when the shell runs on
// one), every open window, and the next boot. A press that never travels is
// still the row's click, and the click a drag ends on switches nothing.
import { mkdirSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  until,
  identityOf,
  openWindow
} from './harness.mjs'

const DIR = userDataDir('workspace-reorder')
const ws = (id, name) => ({
  id,
  name,
  rootDir: fixturePath(`workspace-reorder/${id}`),
  profileFile: null,
  createdAt: 1
})
const ALPHA = ws('ws-alpha', 'Alpha')
const BRAVO = ws('ws-bravo', 'Bravo')
const CHARLIE = ws('ws-charlie', 'Charlie')

const SWITCHER_ROWS = '[data-workspace-id][data-reorder-id]'
const SETTINGS_ROWS = '[data-workspace-row][data-reorder-id]'

const rowOrder = (page, selector) =>
  page.$$eval(selector, (rows) => rows.map((r) => r.getAttribute('data-reorder-id')))
const registryOrder = async (page) =>
  (await page.evaluate(() => window.electronAPI.workspaceLoad())).workspaces.map((w) => w.id)

async function openSwitcher(page) {
  if ((await page.locator(SWITCHER_ROWS).count()) > 0) return
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click()
  await page.locator(SWITCHER_ROWS).first().waitFor({ timeout: 5000 })
}

/** Press on `from`, travel in steps to the top or bottom quarter of `to`, and
 *  report the drop line shown there before releasing. */
async function drag(page, from, to, half) {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  const end = {
    x: b.x + b.width / 2,
    y: half === 'before' ? b.y + b.height / 4 : b.y + (b.height * 3) / 4
  }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      start.x + ((end.x - start.x) * i) / steps,
      start.y + ((end.y - start.y) * i) / steps
    )
  }
  await page.waitForTimeout(80)
  const line = await to.getAttribute('data-drop')
  const faded = await from.getAttribute('data-dragging')
  await page.mouse.up()
  await page.waitForTimeout(150)
  return { line, faded }
}

export async function run(t) {
  for (const w of [ALPHA, BRAVO, CHARLIE]) mkdirSync(w.rootDir, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [ALPHA, BRAVO, CHARLIE],
    activeWorkspaceId: ALPHA.id,
    fresh: true
  })
  seedTrustedRoots(DIR, [ALPHA.rootDir, BRAVO.rootDir, CHARLIE.rootDir])
  let { app, win } = await launchApp(DIR)
  try {
    const second = await openWindow(app, win, BRAVO.id)

    // ── The toolbar switcher ──
    await openSwitcher(win)
    t.equal(
      'the switcher lists the workspaces in registry order',
      JSON.stringify(await rowOrder(win, SWITCHER_ROWS)),
      JSON.stringify([ALPHA.id, BRAVO.id, CHARLIE.id])
    )
    const row = (id) => win.locator(`[data-workspace-id="${id}"]`)
    const shown = await drag(win, row(CHARLIE.id), row(ALPHA.id), 'before')
    t.equal('the drop line shows above the row it lands before', shown.line, 'before')
    t.equal('the dragged row is marked while it travels', shown.faded, 'true')
    const afterDrag = [CHARLIE.id, ALPHA.id, BRAVO.id]
    t.equal(
      'the switcher shows the dragged order at once',
      JSON.stringify(await rowOrder(win, SWITCHER_ROWS)),
      JSON.stringify(afterDrag)
    )
    t.equal(
      'the registry holds the new order',
      JSON.stringify(
        await until(async () => {
          const order = await registryOrder(win)
          return JSON.stringify(order) === JSON.stringify(afterDrag) ? order : null
        })
      ),
      JSON.stringify(afterDrag)
    )
    t.equal(
      'the click a drag ends on switches nothing',
      (await identityOf(win)).workspaceId,
      ALPHA.id
    )

    // The other window takes the new order in.
    await openSwitcher(second.page)
    const otherOrder = await until(async () => {
      const order = await rowOrder(second.page, SWITCHER_ROWS)
      return JSON.stringify(order) === JSON.stringify(afterDrag) ? order : null
    })
    t.equal(
      'another open window lists the new order',
      JSON.stringify(otherOrder ?? (await rowOrder(second.page, SWITCHER_ROWS))),
      JSON.stringify(afterDrag)
    )

    // A drop beside itself changes nothing and writes nothing.
    const still = await drag(win, row(ALPHA.id), row(BRAVO.id), 'before')
    t.equal('a drop right below the row itself shows no line', still.line, null)
    t.equal(
      'a drop that keeps the order leaves it',
      JSON.stringify(await registryOrder(win)),
      JSON.stringify(afterDrag)
    )

    // A press that does not travel is still a click: it switches.
    await row(BRAVO.id).click()
    t.equal(
      'a plain click on a row still switches workspace',
      await until(async () => ((await identityOf(win)).workspaceId === BRAVO.id ? BRAVO.id : null)),
      BRAVO.id
    )

    // ── Settings → Workspaces ──
    await win.getByRole('button', { name: 'Switch workspace', exact: true }).click()
    await win.getByRole('button', { name: 'Manage workspaces…', exact: true }).click()
    await win.locator(SETTINGS_ROWS).first().waitFor({ timeout: 5000 })
    t.equal(
      'Settings lists the dragged order',
      JSON.stringify(await rowOrder(win, SETTINGS_ROWS)),
      JSON.stringify(afterDrag)
    )
    const settingsRow = (id) => win.locator(`[data-workspace-row="${id}"]`)
    const inSettings = await drag(win, settingsRow(CHARLIE.id), settingsRow(BRAVO.id), 'after')
    t.equal('Settings shows the drop line below the row it lands after', inSettings.line, 'after')
    const settled = [ALPHA.id, BRAVO.id, CHARLIE.id]
    t.equal(
      'a drag in Settings reorders the list',
      JSON.stringify(await rowOrder(win, SETTINGS_ROWS)),
      JSON.stringify(settled)
    )
    t.equal(
      'a drag in Settings writes the registry',
      JSON.stringify(
        await until(async () => {
          const order = await registryOrder(win)
          return JSON.stringify(order) === JSON.stringify(settled) ? order : null
        })
      ),
      JSON.stringify(settled)
    )
    t.equal(
      'the click a Settings drag ends on switches nothing',
      (await identityOf(win)).workspaceId,
      BRAVO.id
    )

    // ── The next boot ──
    await app.close()
    app = null
    ;({ app, win } = await launchApp(DIR))
    await openSwitcher(win)
    t.equal(
      'the order survives a restart',
      JSON.stringify(await rowOrder(win, SWITCHER_ROWS)),
      JSON.stringify(settled)
    )
  } finally {
    await app?.close()
  }
}
