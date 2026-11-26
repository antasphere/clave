/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable look script */
// The surfaces the decisions add to the app (PRDCT-5179), put on screen in
// the four themes for a person to look at: the Jev card of Settings →
// Integrations with no key, with a key set and checked, and with a key
// TypeSafe refused; Settings → Helpers with its Decisions list on a machine
// with a key and on one without; and a group's row with the two suggestion
// chips, in a wide and in a narrow sidebar, hovered so its own controls show.
//
// The real app, hidden (`--test-no-activate` through the harness), on the
// decisions' world (tests/e2e/fixtures/jev-world.mjs: three invented
// projects, a stand-in agent) under the run's own /tmp namespace, removed at
// the end, against a stub of TypeSafe on a local port: nothing reaches the
// service. One PNG per surface and theme, `<surface>-<theme>.png`, under
// /tmp/jev-lane-shots/ (never in the repository). Exits non-zero when a state
// cannot be reached.
//
//   npx electron-vite build && node scripts/look-jev-surfaces.mjs
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

process.env.CLAVE_E2E_NS = 'clave-e2e-jev-look'
const OUT = process.env.JEV_LOOK_OUT || '/tmp/jev-lane-shots'
const THEMES = ['dark', 'light', 'coffee', 'charcoal']
const GOOD = 'ts-look-good-key'
const WRONG = 'ts-look-wrong-key'
const WINDOW = { width: 1180, height: 1500 }

const { launchApp, seedWorkspaces, seedTrustedRoots, finishRun, until, killLeakedE2eTmux } =
  await import('../tests/e2e/harness.mjs')
const {
  jevWorld,
  startJevStub,
  shares,
  rowSel,
  chipsOf,
  openSettings,
  openJevCard,
  backToSessions,
  pasteJev,
  cardLine,
  checkedLine,
  groupByKeymap,
  waitName
} = await import('../tests/e2e/fixtures/jev-world.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The app's own skin switch (Settings → Appearance's), as the shots spec does. */
async function setTheme(win, theme) {
  await win.evaluate((t) => window.electronAPI.skinsActivate(t), theme)
  // A bundled skin leaves the root's `data-theme` on its base and lays its
  // own tokens inline (lib/skin.ts): the store's theme is the one it took.
  const set = await until(
    async () =>
      (await win.evaluate(() => window.__claveSessionStoreForTests.getState().theme)) === theme
  )
  if (!set) throw new Error(`the theme ${theme} did not take`)
  await sleep(250)
}

async function setSize(app, { width, height }) {
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height),
    { width, height }
  )
  await sleep(300)
}

/** One element (or a clip of the page) in each theme, at rest: no focus
 *  ring on whatever was clicked, the pointer parked off the sidebar. */
async function shootEach(win, surface, target, { before } = {}) {
  for (const theme of THEMES) {
    await setTheme(win, theme)
    await win.evaluate(() => document.activeElement?.blur?.())
    await win.mouse.move(1, 1)
    if (before) await before(theme)
    const file = path.join(OUT, `${surface}-${theme}.png`)
    if (typeof target === 'function')
      await win.screenshot({ path: file, clip: await target(), animations: 'disabled' })
    else await target.screenshot({ path: file, animations: 'disabled' })
    if (!existsSync(file)) throw new Error(`no shot at ${file}`)
    console.log(`shot ${path.basename(file)}`)
  }
}

/** Where each chip of a group's row is against the box that holds them,
 *  whether the group's name is cut, and whether its controls left the edge. */
const chipLayout = (win, groupId, { squeeze = false } = {}) =>
  win.evaluate(
    ({ id, squeeze }) => {
      const row = document.querySelector(`[data-sidebar-item-id="${id}"] .group-header`)
      const box = row?.querySelector(`[data-group-suggestions="${id}"]`)
      const name = row?.querySelector('span.truncate')
      if (!row || !box || !name) return { missing: true, chips: [] }
      // The self-test: a name squeezed by hand must read as cut.
      if (squeeze) name.style.maxWidth = '1.5rem'
      const r = box.getBoundingClientRect()
      const chips = [...box.querySelectorAll('.badge')].map((chip) => {
        const b = chip.getBoundingClientRect()
        return {
          text: (chip.textContent ?? '').trim(),
          whole:
            b.left >= r.left - 0.5 &&
            b.right <= r.right + 0.5 &&
            b.top >= r.top - 0.5 &&
            b.bottom <= r.bottom + 0.5,
          hidden:
            b.right <= r.left + 0.5 ||
            b.left >= r.right - 0.5 ||
            b.bottom <= r.top + 0.5 ||
            b.top >= r.bottom - 0.5
        }
      })
      const terminals = row.querySelector('[data-group-terminals]')?.getBoundingClientRect()
      const rowBox = row.getBoundingClientRect()
      return {
        chips,
        // Its text measured whole (a Range), against the box it is drawn in: a
        // fraction of a pixel taken from it is already an ellipsis.
        nameCut: (() => {
          const range = document.createRange()
          range.selectNodeContents(name)
          const cut =
            range.getBoundingClientRect().width > name.getBoundingClientRect().width + 0.01
          if (squeeze) name.style.maxWidth = ''
          return cut
        })(),
        // The terminals button ends where the row's own padding begins.
        controlsPushed:
          !terminals ||
          rowBox.right - terminals.right > parseFloat(getComputedStyle(row).paddingRight) + 1
      }
    },
    { id: groupId, squeeze }
  )

let failed = 0
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const world = jevWorld('jev-look')
const stub = await startJevStub({ good: GOOD })
stub.answer({ lightbox: { probabilities: shares(0.14, 0.23, 0.63), fits: 0.9 } })
world.seed()
seedWorkspaces(world.DIR, { workspaces: [world.WS], activeWorkspaceId: world.WS.id, fresh: true })
seedTrustedRoots(world.DIR, [world.ROOT])
killLeakedE2eTmux()
let app = null
try {
  const launched = await launchApp(world.DIR, {
    env: world.env({ CLAVE_JEV_BASE_URL: stub.url }),
    server: 'in-process'
  })
  app = launched.app
  const win = launched.win
  await setSize(app, WINDOW)

  // ── The Jev card, with no key ──
  let card = await openJevCard(win)
  const integrations = win.locator('[data-settings-page="integrations"]')
  await card.locator('[data-testid="jev-key-input"]').waitFor()
  await shootEach(win, 'jev-card-no-key', integrations)

  // ── A key TypeSafe refused ──
  await pasteJev(card, WRONG)
  if (!(await until(() => cardLine(card, 'jev-check-error'))))
    throw new Error('the refused key never said so')
  await shootEach(win, 'jev-card-refused', integrations)

  // ── A key set and checked ──
  await card.locator('[data-testid="jev-replace"]').click()
  await pasteJev(card, GOOD)
  if (!(await until(() => checkedLine(card)))) throw new Error('the good key was never checked')
  await shootEach(win, 'jev-card-checked', integrations)

  // ── Helpers, with a key ──
  const helpers = await openSettings(win, 'helpers')
  const decisions = helpers.locator('[data-decision-row="tab-project"]')
  await decisions.waitFor()
  await shootEach(win, 'helpers-decisions-with-key', helpers)

  // ── A group's row with the two suggestion chips ──
  await backToSessions(win)
  const quill = await world.openTab(app, win, 'Quill one', world.P('quill'), world.SAY.quill(1))
  stub.answer({ quill: { probabilities: shares(0.97, 0.02, 0.01), fits: 0.95 } })
  const named = await groupByKeymap(win, [quill.id])
  if ((await waitName(win, named.id, 'Quill')) !== 'Quill')
    throw new Error('the Quill group was never named')
  const close = await world.openTab(app, win, 'Close call', world.P('lumen'), world.SAY.close)
  const group = await groupByKeymap(win, [close.id])
  if (!(await until(async () => ((await chipsOf(win, group.id)).length === 2 ? true : null))))
    throw new Error('the suggestion chips never came')
  // The sidebar from its top to under the two groups.
  const groupsClip = async () => {
    const shell = await win.locator('[data-sidebar-shell]').first().boundingBox()
    const last = await win.locator(rowSel(named.id)).first().boundingBox()
    if (!shell || !last) throw new Error('no sidebar to shoot')
    return {
      x: shell.x,
      y: shell.y,
      width: shell.width,
      height: last.y + last.height + 80 - shell.y
    }
  }
  for (const [width, px] of [
    ['wide', 340],
    ['narrow', 180]
  ]) {
    await win.evaluate((w) => window.__claveSessionStoreForTests.getState().setSidebarWidth(w), px)
    await sleep(400)
    if (!(await chipLayout(win, group.id, { squeeze: true })).nameCut)
      throw new Error(`${width}: the measure of a cut name cannot see one`)
    const layout = await chipLayout(win, group.id)
    const cut = layout.chips.filter((chip) => !chip.whole && !chip.hidden)
    if (cut.length) throw new Error(`${width}: a chip is cut: ${JSON.stringify(layout)}`)
    if (layout.nameCut)
      throw new Error(`${width}: the group's name gave its room: ${JSON.stringify(layout)}`)
    if (layout.controlsPushed)
      throw new Error(`${width}: the chips push the controls: ${JSON.stringify(layout)}`)
    if (width === 'wide' && layout.chips.some((chip) => !chip.whole))
      throw new Error(`wide: a chip is not shown whole: ${JSON.stringify(layout)}`)
    console.log(
      `${width}: chips ${layout.chips.map((c) => `${c.text} ${c.whole ? 'whole' : 'hidden'}`).join(', ')}`
    )
    await shootEach(win, `group-chips-${width}`, groupsClip)
  }
  await win.evaluate(() => window.__claveSessionStoreForTests.getState().setSidebarWidth(260))
  // The default width, measured and said (no shot): how many chips a person sees there.
  await sleep(400)
  const atDefault = await chipLayout(win, group.id)
  if (atDefault.chips.some((chip) => !chip.whole && !chip.hidden))
    throw new Error(`default: a chip is cut: ${JSON.stringify(atDefault)}`)
  console.log(
    `default (260 px): chips ${atDefault.chips.map((c) => `${c.text} ${c.whole ? 'whole' : 'hidden'}`).join(', ')}`
  )

  // ── Helpers, on a machine without a key ──
  card = await openJevCard(win)
  await card.locator('[data-testid="jev-remove"]').click()
  if (
    !(await until(async () =>
      (await card.locator('[data-testid="jev-key-input"]').count()) ? true : null
    ))
  )
    throw new Error('the key was never removed')
  const bare = await openSettings(win, 'helpers')
  if (
    !(await until(async () =>
      (await bare.locator('[data-decisions-need-key="true"]').count()) ? true : null
    ))
  )
    throw new Error('Helpers never said the key is missing')
  const step = await bare.evaluate((page) => {
    const notice = page
      .querySelector('[data-decisions-integrations-link]')
      ?.closest('.settings-callout')
    const card = page.querySelector('[data-decisions]')
    return notice && card
      ? card.getBoundingClientRect().top - notice.getBoundingClientRect().bottom
      : null
  })
  if (step === null || step < 7.5)
    throw new Error(`the notice of a missing key is ${step} px above the decisions' card`)
  console.log(`the notice stands ${step} px above the card`)
  await shootEach(win, 'helpers-decisions-no-key', bare)
} catch (error) {
  failed = 1
  console.error(String(error?.stack ?? error))
} finally {
  if (app) await app.close().catch(() => {})
  await stub.close()
  finishRun({ failed })
}
console.log(failed ? 'FAILED' : `done: ${OUT}`)
process.exit(failed ? 1 : 0)
