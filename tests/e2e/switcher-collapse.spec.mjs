/**
 * The group switcher's chip row only exists when it holds chips.
 *
 * It used to hold a line open under every sidebar — "No groups yet" at rest in a
 * workspace with nothing running, "No group matches" on a search that found
 * none — which is a permanent strip of furniture saying what the empty panel
 * already said. Now the row collapses to nothing and the panel sits at its head
 * row, and the row opening is itself the news that a group arrived.
 *
 * Asserted on the panel's measured height, not on the absence of a string: a
 * placeholder that comes back under a new class name has to fail this.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath
} from './harness.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const DIR = userDataDir('switcher-collapse')
const ROOT = fixturePath('switcher-collapse-root')
const CLAVE = `${ROOT}/lanes.clave`
const WS = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  name: 'Switcher',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}

/** The panel's head row alone: --toolbar-h, which the panel's min-height is.
 *  Read from the token at run time (it is derived from the frame spec), never
 *  pinned as a number. */
const headOnly = (win) =>
  win.evaluate(() => {
    const pr = document.createElement('div')
    pr.style.height = 'var(--toolbar-h)'
    document.body.appendChild(pr)
    const h = Math.round(pr.getBoundingClientRect().height)
    pr.remove()
    return h
  })

/** What the switcher measures to, and what it is showing. */
const measure = (win) =>
  win.evaluate(() => {
    const panel = document.querySelector('.group-switcher-panel')
    const wrap = document.querySelector('.group-switcher-wrap')
    return {
      panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null,
      wrapH: wrap ? Math.round(wrap.getBoundingClientRect().height) : null,
      empty: wrap?.getAttribute('data-empty') ?? null,
      // What the row would measure if it were not clipped — a placeholder
      // reintroduced under ANY class name shows up here, where keying on
      // `.group-switcher-empty` would go quietly dead on a rename.
      contentH: wrap ? (wrap.firstElementChild?.scrollHeight ?? 0) : null,
      chips: document.querySelectorAll('.group-switcher-chips .group-switcher-chip').length,
      // The head row's own three controls are NOT chips of the wrapping set.
      headChips: document.querySelectorAll('.group-switcher-head .group-switcher-chip').length
    }
  })

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify(
      {
        $schema: 'clave/1.0',
        groups: [
          {
            name: 'Alpha lane',
            cwd: '.',
            color: 'teal',
            sessions: [{ cwd: '.', name: 'seed', claudeMode: false }]
          },
          {
            name: 'Bravo lane',
            cwd: '.',
            color: 'purple',
            sessions: [{ cwd: '.', name: 'seed', claudeMode: false }]
          }
        ]
      },
      null,
      2
    )
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  const HEAD_ONLY = await headOnly(win)
  try {
    // ── At rest with nothing running: the head row and nothing else ──
    const rest = await measure(win)
    t.equal('the chip row is collapsed', rest.wrapH, 0)
    t.equal('the panel is its head row alone', rest.panelH, HEAD_ONLY)
    t.equal('All is still there', rest.headChips, 1)
    t.equal('nothing is in the row to hold it open', rest.contentH, 0)
    t.equal('the collapse hook is on', rest.empty, 'true')

    // ── A search reaching past the running groups opens it ──
    await win.fill('.group-switcher-search input', 'alpha')
    await win.waitForTimeout(600)
    const found = await measure(win)
    t.equal('the search chip is on screen', found.chips, 1)
    t.equal('the row opened for it', found.empty, null)
    t.check('the panel grew with it', found.panelH > HEAD_ONLY, found)

    // ── A search that matches nothing closes it again ──
    await win.fill('.group-switcher-search input', 'zzzz')
    await win.waitForTimeout(600)
    const none = await measure(win)
    t.equal('no match collapses the row', none.wrapH, 0)
    t.equal('back to the head row alone', none.panelH, HEAD_ONLY)

    await win.fill('.group-switcher-search input', '')
    await win.waitForTimeout(600)
    t.equal('and clearing the search leaves it collapsed', (await measure(win)).wrapH, 0)

    // ── Starting a group opens it, and this time it stays ──
    await win.click('button[aria-label="Add a group"]')
    await win.waitForTimeout(700)
    await win.locator('.group-picker-card').first().click()
    await win.waitForTimeout(5000)
    const live = await measure(win)
    t.equal('the running group has a chip', live.chips, 1)
    t.check('the row is open around it', live.panelH > HEAD_ONLY, live)
  } finally {
    await app.close()
  }
}
