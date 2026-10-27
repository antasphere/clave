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

const centre = async (loc) => {
  const b = await loc.boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

async function glide(page, from, to, steps = 12) {
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps
    )
  }
  await page.waitForTimeout(80)
}

/** Press on `from`, travel in steps to the top or bottom quarter of `to`, and
 *  report the drop line shown there. Then, before releasing: `escape` presses
 *  Escape with the button still held, and `then` (a point, or a function
 *  answering one) travels on to it, counting the lines left on the page. */
async function drag(page, from, to, half, { escape = false, then = null } = {}) {
  const b = await to.boundingBox()
  const start = await centre(from)
  const end = {
    x: b.x + b.width / 2,
    y: half === 'before' ? b.y + b.height / 4 : b.y + (b.height * 3) / 4
  }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await glide(page, start, end)
  const line = await to.getAttribute('data-drop')
  const faded = await from.getAttribute('data-dragging')
  if (escape) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
  }
  let linesAfter = null
  if (then) {
    await glide(page, end, typeof then === 'function' ? await then() : then)
    linesAfter = await page.locator('[data-drop]').count()
  }
  await page.mouse.up()
  await page.waitForTimeout(150)
  return { line, faded, linesAfter }
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

    // A drag that comes back onto its own row and is released there clicks
    // nothing: the release is the drag's, not a click on the row.
    const back = await drag(win, row(CHARLIE.id), row(BRAVO.id), 'after', {
      then: () => centre(row(CHARLIE.id))
    })
    t.equal('a drag that travels shows its line', back.line, 'after')
    t.equal('back on its own row, no line is left', back.linesAfter, 0)
    t.equal(
      'releasing a drag on its own row switches nothing',
      (await identityOf(win)).workspaceId,
      ALPHA.id
    )
    t.equal(
      'releasing a drag on its own row leaves the switcher open and the order as it was',
      JSON.stringify(await rowOrder(win, SWITCHER_ROWS)),
      JSON.stringify(afterDrag)
    )

    // Escape cancels the drag: the line goes, the switcher stays open, and the
    // release that follows, back on the dragged row, clicks nothing.
    const escaped = await drag(win, row(CHARLIE.id), row(BRAVO.id), 'after', {
      escape: true,
      then: () => centre(row(CHARLIE.id))
    })
    t.equal('Escape withdraws the drop line', escaped.linesAfter, 0)
    t.equal(
      'the release after Escape switches nothing',
      (await identityOf(win)).workspaceId,
      ALPHA.id
    )
    t.equal(
      'Escape leaves the switcher open and the order as it was',
      JSON.stringify(await rowOrder(win, SWITCHER_ROWS)),
      JSON.stringify(afterDrag)
    )

    // Released outside the list, the drag changes nothing.
    const outside = await drag(win, row(CHARLIE.id), row(BRAVO.id), 'after', {
      then: async () => {
        const list = await win.locator(SWITCHER_ROWS).first().locator('..').boundingBox()
        return { x: list.x + list.width + 60, y: list.y + list.height / 2 }
      }
    })
    t.equal('outside the list the drop line is withdrawn', outside.linesAfter, 0)
    t.equal(
      'a drag released outside the list keeps the order',
      JSON.stringify(await registryOrder(win)),
      JSON.stringify(afterDrag)
    )

    // A press that does not travel is still a click: it switches.
    await openSwitcher(win)
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
    const settingsEscape = await drag(
      win,
      settingsRow(ALPHA.id),
      settingsRow(CHARLIE.id),
      'after',
      {
        escape: true,
        then: () => centre(settingsRow(ALPHA.id))
      }
    )
    t.equal('in Settings, Escape withdraws the drop line', settingsEscape.linesAfter, 0)
    t.equal(
      'in Settings, the release after Escape switches nothing',
      (await identityOf(win)).workspaceId,
      BRAVO.id
    )
    t.equal(
      'in Settings, Escape keeps the order and the page',
      JSON.stringify(await rowOrder(win, SETTINGS_ROWS)),
      JSON.stringify(settled)
    )

    // A drag whose release never arrives (the window lost focus mid-drag and
    // the button came up elsewhere) must not eat the next click, even one on a
    // control inside a row. The lost release cannot be produced natively in a
    // hidden window, so the drag is dispatched and its pointerup withheld.
    const lostDragStarted = await win.evaluate(async (id) => {
      const row = document.querySelector(`[data-workspace-row="${id}"]`)
      const box = row.getBoundingClientRect()
      const at = (dy) => ({
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2 + dy
      })
      row.dispatchEvent(new PointerEvent('pointerdown', at(0)))
      for (let dy = 2; dy <= 20; dy += 2)
        window.dispatchEvent(new PointerEvent('pointermove', at(dy)))
      await new Promise((resolve) => setTimeout(resolve, 100))
      const started = row.hasAttribute('data-dragging')
      window.dispatchEvent(new Event('blur'))
      return started
    }, CHARLIE.id)
    t.check('the withheld-release drag started', lostDragStarted)
    await settingsRow(BRAVO.id)
      .getByRole('button', { name: 'Rename workspace', exact: true })
      .click()
    t.equal(
      'after a drag whose release was lost, the next click on a row control works',
      await win.getByRole('textbox', { name: 'Workspace name', exact: true }).count(),
      1
    )
    await win.keyboard.press('Escape')

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
