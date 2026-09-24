/**
 * Where a new session lands.
 *
 * Two rules, and the second is why the first needs two groups. A group's `+`
 * lands its session in THAT group (PRDCT-1665) — and the sidebar's own launcher
 * lands its session at the TOP of the list, at the top level, whatever was
 * selected when it was pressed. Neither reads the selection any more.
 *
 * Deliberately with TWO groups, because a `+` check on one group is a
 * tautology against any implementation that follows the selection, and because
 * the launcher check needs a selection sitting inside a group to be ignored.
 *
 * Groups are addressed BY NAME here, never by rail index: a new group is now
 * the first row of the sidebar, so stamping A then B renders B above A, and an
 * index-addressed check reads the right count off the wrong lane.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath
} from './harness.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const DIR = userDataDir('group-placement')
const ROOT = fixturePath('placement-root')
const CLAVE = `${ROOT}/two-lanes.clave`
const WS = {
  id: 'eeeeeeee-0000-4000-8000-00000000000e',
  name: 'Placement',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}

const lane = (name, color) => ({
  name,
  cwd: '.',
  color,
  sessions: [
    {
      cwd: '.',
      name: `${name}-seed`,
      claudeMode: false,
      antigravityMode: false,
      codexMode: false,
      dangerousMode: false
    }
  ],
  terminals: []
})

/** Per group, BY NAME: how many session rows it holds and what its first row
 *  is called. Keyed off the group's own `+` button, whose label carries the
 *  name — the one element that names a group and sits inside its card.
 *
 *  Scoped to `.group-scope` on purpose: the LAUNCHER's folder button is
 *  labelled "New session in another folder", so a bare label query picks up a
 *  third "group" that is not one. */
function groupsByName(win) {
  return win.evaluate(() => {
    const out = {}
    for (const card of document.querySelectorAll('.group-scope')) {
      const btn = card.querySelector('[aria-label^="New session in "]')
      if (!btn) continue
      const name = btn.getAttribute('aria-label').slice('New session in '.length).split(' — ')[0]
      const rows = [...card.querySelectorAll('.group-rail [class*="sidebar-item"]')]
      out[name] = { count: rows.length, first: (rows[0]?.textContent || '').trim() }
    }
    return out
  })
}

/** The sidebar's TOP-LEVEL sequence, in order: each entry is a group card or a
 *  loose session row. Document order is sidebar order, and a row inside a card
 *  is that card's, not the list's — so dropping nested rows leaves exactly what
 *  the top level holds, which is what "the top of the list" is about. */
function topLevel(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('.group-scope, [class*="sidebar-item"]')]
      .filter((el) => el.classList.contains('group-scope') || !el.closest('.group-scope'))
      .map((el) =>
        el.classList.contains('group-scope')
          ? {
              kind: 'group',
              name: el
                .querySelector('[aria-label^="New session in "]')
                ?.getAttribute('aria-label')
                .slice('New session in '.length)
                .split(' — ')[0]
            }
          : { kind: 'row', name: (el.textContent || '').trim() }
      )
  )
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify(
      { $schema: 'clave/1.0', groups: [lane('Lane A', 'teal'), lane('Lane B', 'purple')] },
      null,
      2
    )
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    // Pins do not launch themselves; stamp both groups out of the picker, the
    // way a user does.
    for (const nth of [0, 1]) {
      await win.click('button[aria-label="Add a group"]')
      await win.waitForTimeout(700)
      await win.locator('.group-picker-card').nth(nth).click()
      await win.waitForTimeout(6000)
    }

    const before = await groupsByName(win)
    t.equal('two groups are on screen', Object.keys(before).length, 2)

    /** Select the first row of the named group — the selection the placement
     *  rules must now ignore. */
    const selectInside = async (name) => {
      await win
        .locator(`[aria-label^="New session in ${name}"]`)
        .locator('xpath=ancestor::*[contains(@class,"group-scope")][1]')
        .locator('.group-rail [class*="sidebar-item"]')
        .first()
        .click()
      await win.waitForTimeout(1200)
    }

    // ── a group's + lands in THAT group, at the top of it ──────────────────
    // Select inside Lane B, then press Lane A's `+`. A placement that follows
    // the selection puts it in B.
    await selectInside('Lane B')
    await win.locator('button[aria-label="Add a group"]').waitFor()
    await win.locator('[aria-label^="New session in Lane A"]').click()
    await win.waitForTimeout(6000)

    const after = await groupsByName(win)
    t.equal(
      'the session landed in the group whose + was pressed',
      after['Lane A']?.count,
      before['Lane A'].count + 1
    )
    t.equal(
      'and not in the one that happened to be selected',
      after['Lane B']?.count,
      before['Lane B'].count
    )
    t.check(
      'and it is that group’s FIRST row, not appended under the seed',
      after['Lane A']?.first !== 'Lane A-seed' && after['Lane A']?.first?.length > 0,
      after['Lane A']
    )

    // ── the sidebar's launcher lands at the top, outside every group ───────
    // Same selection trap: a row inside Lane B is selected when the launcher
    // is pressed, and the new session must ignore it in both directions — not
    // nested into Lane B, and not appended at the bottom of the list either.
    await selectInside('Lane B')
    const sizesBefore = await groupsByName(win)
    await win.click('.launcher-row button')
    await win.waitForTimeout(6000)

    // The whole top-level sequence, not just "is the first row loose": with the
    // append behaviour restored the loose row still exists, just at the bottom,
    // and a check that only asked whether it was in a group would stay green.
    const order = await topLevel(win)
    t.equal('the launcher’s session is a loose row, not in a group', order[0]?.kind, 'row')
    t.equal(
      'and it is the sidebar’s FIRST item, above both groups',
      order[0]?.name,
      'clave-e2e-placement-root'
    )
    t.check(
      'with the two group cards below it',
      order.slice(1).filter((i) => i.kind === 'group').length === 2,
      order
    )
    const sizesAfter = await groupsByName(win)
    t.equal('so no group grew', sizesAfter['Lane B']?.count, sizesBefore['Lane B'].count)
    t.equal('neither of them', sizesAfter['Lane A']?.count, sizesBefore['Lane A'].count)
  } finally {
    await app.close()
  }
}
