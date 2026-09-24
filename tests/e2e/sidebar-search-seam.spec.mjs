/**
 * Two details of the sidebar's chrome that nothing else can catch.
 *
 * 1. Typing in the switcher's field pre-selects the chip Enter would take. Enter
 *    has always acted on the first chip the search left standing; nothing said
 *    WHICH, so the key was a guess you confirmed by pressing it. The chip now
 *    carries the hover state from the moment you type — asserted as the DOM flag
 *    the CSS keys on AND as a background that actually differs from a plain
 *    chip's, so a rule deleted from main.css fails here too.
 *
 * 2. The seam between the pinned chrome and the scrolling list. The cards pass
 *    behind the switcher, and with nothing between them they died flush against
 *    its bottom border. Asserted on measured geometry — the same 4px that holds
 *    the launcher and the switcher apart, a hairline, and the scroll viewport
 *    starting under it — because "there is a divider element" is true of a
 *    divider that renders as nothing.
 *
 * 3. The same seam at the FOOT of the list, mirrored, and only while the list
 *    overflows. Driven by resizing the window rather than by seeding rows: the
 *    seam is a fact about whether the list fits, so the test that means
 *    anything is making it stop fitting and watching the line arrive.
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

const DIR = userDataDir('sidebar-search-seam')
const ROOT = fixturePath('sidebar-seam-root')
const CLAVE = `${ROOT}/lanes.clave`
const WS = {
  id: 'bbbbbbbb-0000-4000-8000-00000000000b',
  name: 'Seam',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify(
      {
        $schema: 'clave/1.0',
        groups: [
          { name: 'Lane alpha', cwd: '.', color: 'teal', sessions: [{ cwd: '.', name: 'a', claudeMode: false }] },
          { name: 'Lane bravo', cwd: '.', color: 'purple', sessions: [{ cwd: '.', name: 'b', claudeMode: false }] },
          { name: 'Charlie', cwd: '.', color: 'blue', sessions: [{ cwd: '.', name: 'c', claudeMode: false }] }
        ]
      },
      null,
      2
    )
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    // ── The seam, before any typing: it is chrome, not a search affordance ──
    const seam = await win.evaluate(() => {
      const panel = document.querySelector('.group-switcher-panel')
      const rule = document.querySelector('.sidebar-list-seam')
      const viewport = document.querySelector('[data-radix-scroll-area-viewport]')
      const launcher = document.querySelector('.launcher-panel') ?? document.querySelector('.group-switcher-panel')?.parentElement?.previousElementSibling?.firstElementChild
      if (!panel || !rule || !viewport) return null
      const p = panel.getBoundingClientRect()
      const r = rule.getBoundingClientRect()
      const v = viewport.getBoundingClientRect()
      const style = getComputedStyle(rule)
      return {
        gap: Math.round(r.top - p.bottom),
        height: Math.round(r.height),
        // Inset to the same gutter the panel above and the cards below sit on.
        leftAlignedWithPanel: Math.round(r.left) === Math.round(p.left),
        widthMatchesPanel: Math.round(r.width) === Math.round(p.width),
        // Visible: a divider element that paints nothing is not a divider.
        painted: style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent',
        // The list starts under the rule — this is the edge it disappears at.
        viewportUnderRule: Math.round(v.top) >= Math.round(r.bottom),
        launcherPresent: !!launcher
      }
    })
    t.check('the seam is in the DOM with the list under it', seam !== null, seam)
    if (seam) {
      t.equal('4px of air between the switcher and the rule', seam.gap, 4)
      t.equal('the rule is a hairline', seam.height, 1)
      t.check('the rule sits on the panel gutter', seam.leftAlignedWithPanel && seam.widthMatchesPanel, seam)
      t.check('the rule actually paints', seam.painted, seam)
      t.check('the scroll viewport begins under the rule', seam.viewportUnderRule, seam)
    }

    // ── The foot seam: mirrored, and conditional ──────────────────────────
    // Rows first: the `.clave` above declares PINNED groups, which are chips in
    // the switcher and nothing in the list, so the list it leaves behind cannot
    // overflow at any window size. Five open sessions is a list with a height.
    for (let i = 0; i < 5; i++) {
      await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: `row-${i}` })
    }
    await win.waitForTimeout(3000)

    // Then shrink the window until the list cannot fit. The seam has to arrive;
    // the sidebar has to be able to lose it again when the room comes back.
    const setWindowHeight = async (height) => {
      await app.evaluate(async ({ BrowserWindow }, h) => {
        const w = BrowserWindow.getAllWindows()[0]
        const b = w.getBounds()
        w.setBounds({ ...b, height: h })
      }, height)
      await win.waitForTimeout(900)
    }

    const readFootSeam = () =>
      win.evaluate(() => {
        const rule = document.querySelector('.sidebar-list-seam--foot')
        const viewport = document.querySelector('[data-radix-scroll-area-viewport]')
        const top = document.querySelector('.sidebar-list-seam:not(.sidebar-list-seam--foot)')
        if (!rule || !viewport) return { present: false }
        const r = rule.getBoundingClientRect()
        const v = viewport.getBoundingClientRect()
        const t = top?.getBoundingClientRect()
        const style = getComputedStyle(rule)
        // What sits under the seam — a banner if one is showing, else the foot
        // panel. Whichever it is, the 4px is between the line and it.
        const below = rule.nextElementSibling
        const belowBox = below?.getBoundingClientRect()
        return {
          present: true,
          height: Math.round(r.height),
          painted:
            style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
            style.backgroundColor !== 'transparent',
          // The list ends ON the line — the edge it disappears at.
          underViewport: Math.round(r.top) >= Math.round(v.bottom) - 1,
          gapBelow: belowBox ? Math.round(belowBox.top - r.bottom) : null,
          // Same gutter as the seam at the top, so the two line up.
          sameGutterAsTop: t ? Math.round(r.left) === Math.round(t.left) &&
            Math.round(r.width) === Math.round(t.width) : null
        }
      })

    const tallBounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds()
    )
    await setWindowHeight(500)
    const cramped = await readFootSeam()
    t.check('a list that cannot fit grows a seam at its foot', cramped.present === true, cramped)
    if (cramped.present) {
      t.equal('it is the same hairline', cramped.height, 1)
      t.check('and it actually paints', cramped.painted, cramped)
      t.check('the list ends on it', cramped.underViewport, cramped)
      t.equal('4px of air under it, the top seam’s 4px mirrored', cramped.gapBelow, 4)
      t.check('drawn on the same gutter as the seam at the top', cramped.sameGutterAsTop, cramped)
    }

    await setWindowHeight(tallBounds.height)
    const roomy = await readFootSeam()
    t.check(
      'and it goes again once the list fits — no line lying in empty sidebar',
      roomy.present === false,
      roomy
    )

    // ── Typing: the first chip left standing reads as pre-selected ──
    await win.fill('[data-sidebar-search]', 'lane')
    await win.waitForTimeout(500)
    const chips = await win.evaluate(() => {
      const list = [...document.querySelectorAll('.group-switcher-chips .group-switcher-chip')]
      return list.map((c) => ({
        name: c.textContent?.trim() ?? '',
        target: c.getAttribute('data-enter-target'),
        bg: getComputedStyle(c).backgroundColor
      }))
    })
    t.check('the search left more than one chip standing', chips.length > 1, chips)
    t.equal('the first chip is the Enter target', chips[0]?.target, 'true')
    t.check('and it is the only one', chips.filter((c) => c.target === 'true').length === 1, chips)
    t.check(
      'the Enter target is filled where a plain chip is not',
      chips[0]?.bg !== chips[1]?.bg && chips[0]?.bg !== 'rgba(0, 0, 0, 0)',
      chips
    )

    // Cmd+F's target: the shortcut aims at this attribute, and for a while the
    // rebuilt field did not carry it, so the key opened the sidebar and focused
    // nothing. `win.fill` above already proves the selector resolves; this says
    // it resolves to the field the user types groups into.
    const isSearch = await win.evaluate(() => {
      const el = document.querySelector('[data-sidebar-search]')
      return !!el && el.tagName === 'INPUT' && !!el.closest('.group-switcher-search')
    })
    t.check('Cmd+F reaches the switcher search field', isSearch)

    // ── Cleared: the highlight is a fact about a running search ──
    await win.fill('[data-sidebar-search]', '')
    await win.waitForTimeout(400)
    const atRest = await win.evaluate(
      () => document.querySelectorAll('.group-switcher-chip[data-enter-target="true"]').length
    )
    t.equal('no Enter target with an empty field', atRest, 0)
  } finally {
    await app.close()
  }
}
