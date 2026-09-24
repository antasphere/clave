/**
 * Sidebar drag-and-drop moves exactly the row you dragged, and lands it
 * exactly where the indicator said.
 *
 * Two ways the old code moved things the user never touched:
 *
 *   1. Dragging a row that was part of the current selection carried EVERY
 *      selected session. Clicking a group header selects all its sessions (that
 *      is how you view a group's mosaic), so the next drag of any one of its
 *      rows emptied the whole group into the drop target.
 *
 *   2. A collapsed group keeps its child rows in the DOM (height-0 grid track,
 *      overflow hidden), and those rows' bounding rects still extend over the
 *      items rendered BELOW the group. The hit-test walked items in DOM order
 *      and matched an invisible child first, so a drop aimed at the group under
 *      a collapsed one silently landed inside the collapsed one.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  fixturePath
} from './harness.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const DIR = userDataDir('sidebar-dnd')
const ROOT = fixturePath('sidebar-dnd-root')
const CLAVE = `${ROOT}/lanes.clave`
const WS = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  name: 'Dnd',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}

const plain = (name) => ({
  cwd: '.',
  name,
  claudeMode: false,
  antigravityMode: false,
  codexMode: false,
  dangerousMode: false
})
const lane = (name, color, count) => ({
  name,
  cwd: '.',
  color,
  sessions: Array.from({ length: count }, (_, i) => plain(`${name}-${i + 1}`)),
  terminals: []
})

/** The rendered sidebar, group by group: name, collapsed flag, member row ids. */
function layout(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('.group-scope')].map((card) => {
      const header = card.querySelector('[data-sidebar-item-type="group"]')
      return {
        id: header?.dataset.sidebarItemId ?? null,
        name: header?.querySelector('span.truncate')?.textContent ?? null,
        ids: [...card.querySelectorAll('.group-rail [data-sidebar-item-id]')].map(
          (el) => el.dataset.sidebarItemId
        )
      }
    })
  )
}

async function centerOf(win, selector, { yFraction = 0.5 } = {}) {
  const box = await win.locator(selector).boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  return { x: box.x + box.width / 2, y: box.y + box.height * yFraction }
}

/** A real pointer drag: down on `from`, move past the 5px threshold in steps,
 *  hover the target long enough for the debounced indicator. `release` ends it. */
/** Where the pressed pointer is right now (kept by dragTo/hoverTo). */
let pointerAt = { x: 0, y: 0 }

/** Move the already-pressed pointer to `target` (a point or a getter),
 *  re-aiming like dragTo. Never presses — a second press mid-drag would start
 *  a new drag on whatever is under the cursor. */
async function hoverTo(win, target) {
  const aim = typeof target === 'function' ? target : () => target
  const glide = async (to) => {
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      await win.mouse.move(pointerAt.x + ((to.x - pointerAt.x) * i) / steps, pointerAt.y + ((to.y - pointerAt.y) * i) / steps)
      await win.waitForTimeout(20)
    }
    pointerAt = to
  }
  await glide(await aim())
  for (let i = 0; i < 4; i++) {
    await win.waitForTimeout(150)
    const to = await aim()
    if (Math.abs(to.y - pointerAt.y) < 1 && Math.abs(to.x - pointerAt.x) < 1) break
    await glide(to)
  }
  await win.waitForTimeout(150)
}

async function dragTo(win, from, target) {
  // `target` is a point or a getter for one. A getter is re-read while
  // hovering, the way a hand tracks a row that the drop line's gap has just
  // pushed down the list — a fixed coordinate would end up over whatever moved
  // under it instead.
  const aim = typeof target === 'function' ? target : () => target
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  pointerAt = { x: from.x, y: from.y }
  await hoverTo(win, target)
}
async function release(win) {
  await win.mouse.up()
  await win.waitForTimeout(600)
}
async function drag(win, from, to) {
  await dragTo(win, from, to)
  await release(win)
}

/** Where the drop line is right now: the sidebar item id it sits directly
 *  above (in DOM order), or null when no line is shown. */
function activeLineBefore(win) {
  return win.evaluate(() => {
    const gap = document.querySelector('.sidebar-drop-gap-active')
    if (!gap) return null
    let el = gap.nextElementSibling
    while (el && !el.matches('[data-sidebar-item-id]')) el = el.querySelector?.('[data-sidebar-item-id]') ?? el.nextElementSibling
    return el?.dataset.sidebarItemId ?? 'end'
  })
}

const rowSel = (id) => `[data-sidebar-item-id="${id}"]`

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify(
      {
        $schema: 'clave/1.0',
        groups: [lane('Alpha', 'teal', 3), lane('Beta', 'purple', 1), lane('Gamma', 'blue', 1)]
      },
      null,
      2
    )
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    for (const nth of [0, 1, 2]) {
      await win.click('button[aria-label="Add a group"]')
      await win.waitForTimeout(700)
      await win.locator('.group-picker-card').nth(nth).click()
      await win.waitForTimeout(5000)
    }

    let before = await layout(win)
    t.equal('three groups are on screen', before.length, 3)
    // BY NAME, never by index. A newly launched group is now the sidebar's
    // first row, so stamping Alpha, Beta, Gamma renders them Gamma, Beta,
    // Alpha — and a positional read quietly binds `alpha` to Gamma, which
    // fails as "Alpha has one session" rather than as "you read the wrong
    // lane". `layout()` already carries each card's name; use it.
    const byName = (n) => before.find((g) => g.name === n)
    const [alpha, beta, gamma] = [byName('Alpha'), byName('Beta'), byName('Gamma')]
    t.check('all three lanes are named on screen', !!alpha && !!beta && !!gamma, before)
    t.equal('Alpha has three sessions', alpha.ids.length, 3)
    t.equal('Beta has one session', beta.ids.length, 1)
    t.equal('Gamma has one session', gamma.ids.length, 1)

    // ── 1. A drag moves the row under the cursor, not the whole selection ──
    // Click Alpha's header: selects all three of its sessions (the mosaic view).
    await win.locator(`${rowSel(alpha.id)} span.truncate`).click()
    await win.waitForTimeout(500)
    // Drag Alpha's SECOND row into Beta (expanded group header, lower part = inside).
    await drag(win, await centerOf(win, rowSel(alpha.ids[1])), () =>
      centerOf(win, rowSel(beta.id), { yFraction: 0.75 })
    )
    let after = await layout(win)
    const alphaAfter = after.find((g) => g.id === alpha.id)
    const betaAfter = after.find((g) => g.id === beta.id)
    t.check('Alpha still exists after dragging one of its rows away', !!alphaAfter, after)
    t.equal(
      'only the dragged row left Alpha',
      alphaAfter?.ids.join(','),
      [alpha.ids[0], alpha.ids[2]].join(',')
    )
    t.equal(
      'Beta gained exactly that row',
      betaAfter?.ids.join(','),
      [...beta.ids, alpha.ids[1]].join(',')
    )

    // ── 2. A collapsed group's hidden rows never catch a drop ──
    // Collapse Alpha via its folder disclosure (not the header click, which
    // selects). Beta now sits directly below the collapsed card.
    before = after
    await win.locator(`${rowSel(alpha.id)} .sidebar-tab-icon`).first().click()
    await win.waitForTimeout(600)
    // Drag Gamma's session onto Beta's header (inside).
    const gammaRow = before.find((g) => g.id === gamma.id).ids[0]
    await drag(win, await centerOf(win, rowSel(gammaRow)), () =>
      centerOf(win, rowSel(beta.id), { yFraction: 0.75 })
    )
    after = await layout(win)
    const alphaFinal = after.find((g) => g.id === alpha.id)
    const betaFinal = after.find((g) => g.id === beta.id)
    t.equal(
      'the collapsed group above did not swallow the drop',
      alphaFinal?.ids.join(','),
      alphaAfter?.ids.join(',')
    )
    t.equal(
      'the row landed in the group the indicator pointed at',
      betaFinal?.ids.join(','),
      [...(betaAfter?.ids ?? []), gammaRow].join(',')
    )

    // ── 3. The FIRST position of another group is reachable, with a line ──
    // Expand Alpha again; drag Beta's last row onto the top of Alpha's first row.
    await win.locator(`${rowSel(alpha.id)} .sidebar-tab-icon`).first().click()
    await win.waitForTimeout(600)
    before = await layout(win)
    const alphaRows = before.find((g) => g.id === alpha.id).ids
    const betaRows = before.find((g) => g.id === beta.id).ids
    const mover = betaRows[betaRows.length - 1]
    await dragTo(win, await centerOf(win, rowSel(mover)), () =>
      centerOf(win, rowSel(alphaRows[0]), { yFraction: 0.2 })
    )
    t.equal('a line is shown above the first row of the target group', await activeLineBefore(win), alphaRows[0])
    await release(win)
    after = await layout(win)
    t.equal(
      'the row became the FIRST of the target group',
      after.find((g) => g.id === alpha.id)?.ids.join(','),
      [mover, ...alphaRows].join(',')
    )

    // ── 4. The LAST position: the strip at the foot of the group is the drop zone ──
    before = after
    const alphaNow = before.find((g) => g.id === alpha.id).ids
    const mover2 = before.find((g) => g.id === beta.id).ids.at(-1)
    await dragTo(win, await centerOf(win, rowSel(mover2)), () =>
      centerOf(win, `[data-sidebar-drop-zone="group-end"][data-group-id="${alpha.id}"]`)
    )
    t.equal('a line is shown below the last row of the target group', await activeLineBefore(win), 'end')
    await release(win)
    after = await layout(win)
    t.equal(
      'the row became the LAST of the target group',
      after.find((g) => g.id === alpha.id)?.ids.join(','),
      [...alphaNow, mover2].join(',')
    )

    // ── 5. The last row's bottom half is the last position too ──
    before = after
    const alphaThen = before.find((g) => g.id === alpha.id).ids
    const mover3 = before.find((g) => g.id === beta.id).ids[0]
    await drag(win, await centerOf(win, rowSel(mover3)), () =>
      centerOf(win, rowSel(alphaThen.at(-1)), { yFraction: 0.8 })
    )
    after = await layout(win)
    t.equal(
      'dropping on the bottom half of the last row appends after it',
      after.find((g) => g.id === alpha.id)?.ids.join(','),
      [...alphaThen, mover3].join(',')
    )
    t.check('the group emptied by that move is gone', !after.some((g) => g.id === beta.id), after)

    // ── 6. The line holds still on a row's midline (hysteresis) ──
    const rows = after.find((g) => g.id === alpha.id).ids
    await dragTo(win, await centerOf(win, rowSel(rows[0])), () =>
      centerOf(win, rowSel(rows[2]), { yFraction: 0.5 })
    )
    const mid = await centerOf(win, rowSel(rows[2]), { yFraction: 0.5 })
    const seen = new Set()
    for (let i = 0; i < 12; i++) {
      await win.mouse.move(mid.x, mid.y + (i % 2 === 0 ? 1 : -1))
      await win.waitForTimeout(70)
      seen.add(await activeLineBefore(win))
    }
    t.equal('jittering 1px around a midline never moves the line', seen.size, 1)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)

    // ── 7. From inside the group, the header means "first position" ──
    // Dragging the LAST row up past the first one lands on the header; that
    // used to read as "inside" = append at the end, sending it straight back.
    before = await layout(win)
    const rowsNow = before.find((g) => g.id === alpha.id).ids
    const lastRow = rowsNow[rowsNow.length - 1]
    await dragTo(win, await centerOf(win, rowSel(lastRow)), () =>
      centerOf(win, rowSel(alpha.id), { yFraction: 0.8 })
    )
    t.equal('the line sits above the first row, not around the group', await activeLineBefore(win), rowsNow[0])
    t.equal(
      'no card outline is shown for a row that is already inside',
      await win.evaluate(() => document.querySelectorAll('.group-scope .border-accent').length),
      0
    )
    await release(win)
    after = await layout(win)
    t.equal(
      'the last row became the first',
      after.find((g) => g.id === alpha.id)?.ids.join(','),
      [lastRow, ...rowsNow.slice(0, -1)].join(',')
    )

    // ── 8. A row's own place is always a valid target, and it means "stay" ──
    // Hovering your own faded row inside a multi-row group: nothing moves.
    before = after
    const alphaIds = before.find((g) => g.id === alpha.id).ids
    const self = alphaIds[2]
    await dragTo(win, await centerOf(win, rowSel(self)), () => centerOf(win, rowSel(alphaIds[0])))
    await hoverTo(win, () => centerOf(win, rowSel(self)))
    t.equal('over its own faded row, no line is shown', await activeLineBefore(win), null)
    await release(win)
    after = await layout(win)
    t.equal('and releasing there changes nothing', after.find((g) => g.id === alpha.id)?.ids.join(','), alphaIds.join(','))

    // A single-row group: start dragging its only row toward Alpha, change
    // your mind, come back — onto the header, then onto the row.
    const solo = await callMcp(app, 'createGroup', { name: 'Solo' })
    await callMcp(app, 'moveSession', { sessionId: alphaIds.at(-1), groupId: solo.groupId })
    await win.waitForTimeout(600)
    before = await layout(win)
    const soloGroup = before.find((g) => g.id === solo.groupId)
    t.equal('the single-row group is on screen', soloGroup?.ids.length, 1)
    const only = soloGroup.ids[0]
    for (const [where, target] of [
      ['header', () => centerOf(win, rowSel(solo.groupId), { yFraction: 0.7 })],
      ['row', () => centerOf(win, rowSel(only))]
    ]) {
      await dragTo(win, await centerOf(win, rowSel(only)), () => centerOf(win, rowSel(alpha.id), { yFraction: 0.75 }))
      await hoverTo(win, target)
      t.equal(`back over its own ${where}, no line is shown`, await activeLineBefore(win), null)
      await release(win)
      after = await layout(win)
      t.equal(`released on its own ${where}, the single-row group keeps its row`, after.find((g) => g.id === solo.groupId)?.ids.join(','), only)
    }

    // ── 9. The last row, hovering around its own place, is not offered outside ──
    // Drag Alpha's last row up to its first row, then come back down onto the
    // strip under the last row, then 8px past the card's bottom edge: the
    // target stays the last position inside the card the whole way.
    before = await layout(win)
    const aIds = before.find((g) => g.id === alpha.id).ids
    const tail = aIds[aIds.length - 1]
    const cardBottom = async () => {
      const box = await win.locator(`.group-scope:has(${rowSel(alpha.id)})`).boundingBox()
      return { x: box.x + box.width / 2, y: box.y + box.height }
    }
    await dragTo(win, await centerOf(win, rowSel(tail)), () => centerOf(win, rowSel(aIds[0]), { yFraction: 0.2 }))
    await hoverTo(win, () => centerOf(win, `[data-sidebar-drop-zone="group-end"][data-group-id="${alpha.id}"]`))
    t.equal('on the strip under its own row, the line is the last position inside', await activeLineBefore(win), tail)
    await hoverTo(win, async () => { const b = await cardBottom(); return { x: b.x, y: b.y + 8 } })
    t.equal('8px past the card edge it still holds the last position inside', await activeLineBefore(win), tail)
    await release(win)
    after = await layout(win)
    t.equal('and releasing there leaves the group as it was', after.find((g) => g.id === alpha.id)?.ids.join(','), aIds.join(','))
  } finally {
    await app.close()
  }
}
