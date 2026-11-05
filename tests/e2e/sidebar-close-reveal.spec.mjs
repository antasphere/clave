// Pinned to the in-process server: the rows come from the agent tools
// (openSession, createGroup, moveSession, sendToSession), which main answers
// from its own session host. Not a known failure.
/**
 * The session row's close cross takes no room until the row is hovered or
 * focused, and a row another tab wrote to draws the check, not an envelope
 * (PRDCT-4078).
 *
 * At rest the cross has no width and no gap, so the title has the room the
 * invisible box used to hold, and the status glyph ends at the row's padding
 * edge. Hovering the row slides the cross in to its full width, with the
 * glyph as far from the row's right edge as from its top and bottom; what the
 * title gives up is exactly the box, the row's gap and the box's pull into the
 * row's padding, read from the computed styles, since the pull follows the
 * density. Keyboard
 * focus on the row reveals it, Tab reaches it, and Enter on it closes the tab
 * without starting the row's rename. Under reduced motion it appears without
 * sliding. The four themes draw it with an ink of their own. A row another tab
 * wrote to shows the blue check and a tooltip naming the tab.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  until,
  killLeakedE2eTmux,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('sidebar-close-reveal')
const ROOT = fixturePath('sidebar-close-reveal-root')
const SCRIPT = `${ROOT}/codex.py`
const WS = { id: 'close-ws', name: 'Close', rootDir: ROOT, profileFile: null, createdAt: 1 }
const LONG = 'A session title long enough to be cut short by the width the hidden cross held'
const THEMES = ['dark', 'light', 'coffee', 'charcoal']

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  // A Codex stand-in: it only sets the title Clave reads, so a message from
  // another tab can land on an agent row without starting a model.
  writeFileSync(
    SCRIPT,
    `import sys
sys.stdout.write('\\x1b]0;codex | Ready\\x07'); sys.stdout.flush()
for line in sys.stdin:
    if line.strip() == 'exit': break
`
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR, { server: 'in-process' })
  try {
    const open = async (payload) =>
      (await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', ...payload })).sessionId
    const rowOf = (id) => win.locator(`[data-sidebar-item-id="${id}"] .sidebar-item`)
    const closeOf = (id) => rowOf(id).locator('.sidebar-item-close')
    const nameOf = (id) => rowOf(id).locator('[data-testid="session-tab-name"]')
    // Never waits: a cross that is not in the DOM is a finding, not a timeout.
    const width = async (loc) =>
      (await loc.count()) === 0 ? null : ((await loc.boundingBox())?.width ?? null)
    const awayFromTheSidebar = async () => {
      const size = await win.evaluate(() => [window.innerWidth, window.innerHeight])
      await win.mouse.move(size[0] * 0.75, size[1] * 0.5)
    }
    /** The row's geometry as the reader sees it: where the status glyph ends
     *  against the row's padding edge, and where the cross's glyph sits. */
    const geometry = (id) =>
      rowOf(id).evaluate((row) => {
        const r = row.getBoundingClientRect()
        const paddingRight = parseFloat(getComputedStyle(row).paddingRight)
        const status = row.querySelector('.sidebar-tab-status')?.getBoundingClientRect()
        const cross = row.querySelector('.sidebar-item-close svg')?.getBoundingClientRect()
        const box = row.querySelector('.sidebar-item-close')
        return {
          statusGap: status ? Math.round((r.right - paddingRight - status.right) * 10) / 10 : null,
          cross: cross
            ? {
                top: Math.round((cross.top - r.top) * 10) / 10,
                bottom: Math.round((r.bottom - cross.bottom) * 10) / 10,
                right: Math.round((r.right - cross.right) * 10) / 10
              }
            : null,
          opacity: box ? getComputedStyle(box).opacity : null,
          transition: box ? getComputedStyle(box).transitionProperty : null,
          transform: box ? getComputedStyle(box).transform : null,
          // The room the cross takes from the title once shown: its box, the
          // row's gap before it, and its (negative) pull into the row's padding.
          room: box
            ? Math.round(
                (box.getBoundingClientRect().width +
                  parseFloat(getComputedStyle(row).columnGap) +
                  parseFloat(getComputedStyle(box).marginRight)) *
                  10
              ) / 10
            : null
        }
      })

    const ungrouped = await open({ name: LONG })
    const plain = await open({ name: 'A row to close from the keyboard' })
    const group = await callMcp(app, 'createGroup', { name: 'Grouped' })
    const grouped = await open({ name: `${LONG}, in a group` })
    await callMcp(app, 'moveSession', { sessionId: grouped, groupId: group.groupId })
    for (const id of [ungrouped, plain, grouped]) await closeOf(id).waitFor({ state: 'attached' })
    await awayFromTheSidebar()

    for (const [label, id] of [
      ['ungrouped', ungrouped],
      ['grouped', grouped]
    ]) {
      const rest = await geometry(id)
      t.equal(`${label}: the close cross takes no room at rest`, await width(closeOf(id)), 0)
      t.equal(
        `${label}: at rest the status glyph ends at the row's padding edge`,
        rest.statusGap,
        0
      )
      t.check(
        `${label}: the long title is cut short`,
        await nameOf(id).evaluate((el) => el.scrollWidth > el.clientWidth),
        await nameOf(id).evaluate((el) => [el.scrollWidth, el.clientWidth])
      )
      const titleAtRest = await width(nameOf(id))

      await rowOf(id).hover()
      const shown = await until(async () => Math.abs((await width(closeOf(id))) - 20) < 0.5)
      t.check(
        `${label}: hovering the row slides the close cross in to its full width`,
        shown === true,
        await width(closeOf(id))
      )
      const hovered = await geometry(id)
      t.equal(`${label}: the cross is fully drawn once in`, hovered.opacity, '1')
      t.check(
        `${label}: the cross's glyph sits as far from the row's right edge as from its top and bottom`,
        hovered.cross &&
          Math.abs(hovered.cross.right - hovered.cross.top) <= 1 &&
          Math.abs(hovered.cross.top - hovered.cross.bottom) <= 1,
        hovered.cross
      )
      const titleHovered = await width(nameOf(id))
      t.check(
        `${label}: the title gives the cross exactly its box, the row's gap and its pull into the padding (${hovered.room}px at this density)`,
        hovered.room !== null && Math.abs(titleAtRest - titleHovered - hovered.room) <= 0.5,
        { titleAtRest, titleHovered, room: hovered.room }
      )
      await awayFromTheSidebar()
      t.check(
        `${label}: the cross is away again once the pointer leaves the row`,
        (await until(async () => (await width(closeOf(id))) === 0)) === true,
        await width(closeOf(id))
      )
    }

    // The keyboard: the row's focus reveals the cross; Tab reaches it, and
    // Enter on it closes the tab without the row's own Enter (a rename).
    await rowOf(plain).focus()
    await win.keyboard.press('Shift+Tab')
    await win.keyboard.press('Tab')
    t.check(
      'keyboard focus on the row reveals the close cross',
      (await until(async () => (await geometry(plain)).opacity === '1')) === true,
      await geometry(plain)
    )
    await win.keyboard.press('Tab')
    t.check(
      'Tab moves from the row to its close cross',
      await win.evaluate(() => document.activeElement?.classList.contains('sidebar-item-close')),
      await win.evaluate(() => document.activeElement?.className)
    )
    await win.keyboard.press('Enter')
    // A session's close asks first, from the keyboard as from a click.
    const dialog = win.getByRole('dialog').filter({ hasText: 'Delete session' })
    t.check(
      'Enter on the close cross asks to delete the session, as a click does',
      (await until(async () => (await dialog.count()) > 0)) === true,
      await win.locator('[role="dialog"]').count()
    )
    t.equal(
      'and no rename field opened in the sidebar',
      await win.locator('[data-sidebar-item-type="session"] input').count(),
      0
    )
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    t.check(
      'confirming removes the row',
      (await until(async () => (await rowOf(plain).count()) === 0)) === true,
      await rowOf(plain).count()
    )

    // Reduced motion: the cross appears in place, with no slide and no width
    // that animates.
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await awayFromTheSidebar()
    const reduced = await geometry(ungrouped)
    t.check(
      'under reduced motion the cross is not slid aside while away',
      reduced.transform === 'none',
      reduced.transform
    )
    t.check(
      'under reduced motion no width or movement animates',
      !/width|transform|margin/.test(reduced.transition ?? ''),
      reduced.transition
    )
    await rowOf(ungrouped).hover()
    t.check(
      'under reduced motion the hover still shows the cross',
      (await until(async () => (await width(closeOf(ungrouped))) === 20)) === true,
      await width(closeOf(ungrouped))
    )
    await win.emulateMedia({ reducedMotion: 'no-preference' })
    await awayFromTheSidebar()

    // The four themes each draw the cross with an ink of their own. A theme
    // is switched the way the reader does it, from Settings → Appearance: the
    // active skin writes its tokens inline on the root, so the attribute alone
    // would leave the colours as they were.
    for (const theme of THEMES) {
      await win.click('.sidebar-footer-btn[aria-label="Settings"]')
      await win.click('[data-settings-nav-row="appearance"]')
      await win.click(`[data-theme-option="${theme}"]`)
      await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
      // The root attribute carries a skin's base (coffee rests on light,
      // charcoal on dark); the app records the theme it is on by name.
      t.equal(
        `${theme}: the theme is on`,
        await win.evaluate(() => localStorage.getItem('clave-theme')),
        theme
      )
      await rowOf(grouped).hover()
      await until(async () => (await width(closeOf(grouped))) === 20)
      const ink = await closeOf(grouped).evaluate((el) => getComputedStyle(el).color)
      t.check(`${theme}: the cross has an ink`, ink && ink !== 'rgba(0, 0, 0, 0)', ink)
      await awayFromTheSidebar()
    }

    // A narrow sidebar: the cross still lands inside the row.
    const handle = win.locator('.cursor-col-resize').first()
    const hb = await handle.boundingBox()
    if (hb) {
      await win.mouse.move(hb.x + hb.width / 2, hb.y + 200)
      await win.mouse.down()
      await win.mouse.move(hb.x - 120, hb.y + 200, { steps: 6 })
      await win.mouse.up()
    }
    const narrow = await until(async () => {
      const r = await rowOf(grouped).boundingBox()
      return r && r.width < 200 ? r : null
    })
    t.check('the sidebar can be dragged narrow', !!narrow, narrow)
    await rowOf(grouped).hover()
    await until(async () => (await width(closeOf(grouped))) === 20)
    t.check(
      'narrow: the cross stays inside the row',
      await rowOf(grouped).evaluate((row) => {
        const r = row.getBoundingClientRect()
        const c = row.querySelector('.sidebar-item-close')?.getBoundingClientRect()
        return !!c && c.right <= r.right + 0.5 && c.left >= r.left
      }),
      await geometry(grouped)
    )
    await awayFromTheSidebar()

    // A row another tab wrote to: the check, blue, and a tooltip naming the tab.
    await win.evaluate(async (script) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'close-codex',
        name: 'Close Codex',
        family: 'codex',
        command: ['/usr/bin/python3', script],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetGlobal('codex', 'close-codex')
    }, SCRIPT)
    // One tab may only write to a tab of its own group.
    const writer = await open({ name: 'Writer' })
    const written = await open({ mode: 'codex', name: 'Written to' })
    const writers = await callMcp(app, 'createGroup', { name: 'Writers' })
    for (const id of [writer, written])
      await callMcp(app, 'moveSession', { sessionId: id, groupId: writers.groupId })
    const status = rowOf(written).locator('.sidebar-tab-status')
    await status.waitFor()
    await callMcp(app, 'focus', { sessionId: writer })
    await callMcp(app, 'sendToSession', {
      sessionId: written,
      message: 'A message from the Writer tab.',
      callerSessionId: writer
    })
    t.check(
      'a message from another tab leaves the row unread',
      (await until(async () => (await status.getAttribute('data-status')) === 'unread')) === true,
      await status.getAttribute('data-status')
    )
    t.equal(
      'an unread row another tab wrote to draws the check',
      await status.getAttribute('data-glyph'),
      'check'
    )
    t.equal('and the check is blue', await status.getAttribute('data-tone'), 'blue')
    t.check(
      'its tooltip names the tab that wrote',
      ((await status.getAttribute('aria-label')) ?? '').startsWith('Message from '),
      await status.getAttribute('aria-label')
    )
    t.equal(
      'no row draws an envelope',
      await win.locator('.sidebar-tab-status[data-glyph="envelope"]').count(),
      0
    )
  } finally {
    await app.close()
    killLeakedE2eTmux()
  }
}
