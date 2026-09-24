/**
 * Appearance → Density: one slider, the whole control and frame spec.
 *
 * Everything here fails SILENTLY in the app, which is why it is asserted
 * against the real renderer rather than eyeballed on a screenshot:
 *
 *  - `--density` is a CSS custom property. Written with a value the engine
 *    cannot use — a stale id from an older build, an empty string — every
 *    calc() in the spec becomes invalid at once, the tokens fall back to
 *    their initial values, and nothing throws, warns or logs. The app just
 *    quietly stops responding to the slider.
 *  - A token that is NOT cut from `--density` keeps its default at every stop.
 *    At the middle stop, which is 1, that is indistinguishable from a token
 *    that is; it only shows when someone moves the slider and one family of
 *    controls stays behind while the rest resize around it.
 *  - The setting is written on the root element by AppShell, and `applySkin`
 *    clears the properties it wrote each time a skin is activated. If
 *    `--density` ever joined that set, activating a skin would silently reset
 *    the user's density to the default — an app that looks right, a setting
 *    that keeps forgetting.
 *
 * So the checks read COMPUTED lengths out of the live document at each stop,
 * not the stylesheet's text, and they drive the slider with the keyboard
 * rather than by calling the store: the control being operable is half the
 * requirement.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  spawnAgentTabIn,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'
import { mkdirSync } from 'node:fs'

const DIR = userDataDir('density')
const ROOT = fixturePath('density-root')
const WS = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  name: 'Density',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** The five stops, mirrored from session-types.ts. Mirrored on purpose: a spec
 *  that imports the table it is checking agrees with itself whatever the table
 *  says, and would pass just as happily if every scale were set to 1. */
const STOPS = [
  { id: 'compact', label: 'Compact', scale: 0.875 },
  { id: 'snug', label: 'Snug', scale: 0.9375 },
  { id: 'regular', label: 'Regular', scale: 1 },
  { id: 'relaxed', label: 'Relaxed', scale: 1.0625 },
  { id: 'spacious', label: 'Spacious', scale: 1.125 }
]

/** Every metric the slider must move, with its value in px at --density: 1.
 *  These are the numbers written in tokens.css, resolved by hand. */
const METRICS = {
  '--control-h': 28,
  '--control-h-xs': 20,
  '--control-h-sm': 24,
  '--control-h-md': 28,
  '--control-h-lg': 32,
  '--control-px': 8,
  '--control-gap': 6,
  '--control-text': 13,
  '--control-icon': 16,
  '--control-radius': 6,
  '--frame-h': 28,
  '--frame-radius': 6,
  '--framed-control-icon': 14,
  '--radius-lg': 6,
  '--radius-2xl': 14,
  '--surface-inset': 4,
  '--toolbar-h': 28,
  '--sidebar-row-h': 28,
  '--sidebar-row-px': 10,
  '--sidebar-tab-icon-size': 15,
  '--panel-row-h': 28,
  '--git-tree-row-h': 30
}

/** The hairlines and the one skinnable metric, which must NOT move. */
const FIXED = { '--frame-border': 1, '--frame-inset': 1, '--row-gap': 2 }

/** Resolve custom properties to the px the engine actually computes. A custom
 *  property read straight back gives the unevaluated calc() text, so each one
 *  is put on a probe element's width and read back off the box. */
const RESOLVE = (names) => {
  const probe = document.createElement('div')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  document.body.appendChild(probe)
  const out = {}
  for (const name of names) {
    probe.style.width = `var(${name})`
    const value = getComputedStyle(probe).width
    out[name] = value.endsWith('px') ? Number(value.slice(0, -2)) : value
  }
  probe.remove()
  return out
}

const ALL = [...Object.keys(METRICS), ...Object.keys(FIXED)]
/** Two lengths agree to within a rounding step of the engine's subpixel grid. */
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.02

async function openDensity(win) {
  await win.click('.sidebar-footer-btn[aria-label="Settings"]')
  await win.click('[data-settings-nav-row="appearance"]')
  await win.waitForSelector('[data-testid="density-slider"]')
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  let { app, win } = await launchApp(DIR)
  try {
    await openDensity(win)

    // ── The default is the spec, byte for byte ──────────────────────────────
    // The whole promise of "the current values are the default" is this check:
    // a user who never opens this section must see the file as it was written.
    const base = await win.evaluate(RESOLVE, ALL)
    const wrongAtDefault = Object.entries({ ...METRICS, ...FIXED }).filter(
      ([name, px]) => !near(base[name], px)
    )
    t.check(
      'every metric resolves to its written value at the default stop',
      wrongAtDefault.length === 0,
      wrongAtDefault.map(([n, px]) => `${n}: expected ${px}, got ${base[n]}`)
    )
    t.equal(
      'the default stop is Regular',
      await win.textContent('[data-testid="density-value"]'),
      'Regular'
    )
    t.equal(
      'the slider opens on the middle stop',
      await win.inputValue('[data-testid="density-slider"]'),
      '2'
    )

    // ── The slider is operable from the keyboard ────────────────────────────
    // Focus it and walk left with the arrow keys: a range input gets this from
    // the platform, and a hand-rolled control is exactly what would not.
    await win.focus('[data-testid="density-slider"]')
    await win.keyboard.press('ArrowLeft')
    await win.keyboard.press('ArrowLeft')
    t.equal(
      'two ArrowLefts reach the first stop',
      await win.inputValue('[data-testid="density-slider"]'),
      '0'
    )
    t.equal(
      'the value label follows the slider',
      await win.textContent('[data-testid="density-value"]'),
      'Compact'
    )
    t.equal(
      'the slider names its stop for a screen reader',
      await win.getAttribute('[data-testid="density-slider"]', 'aria-valuetext'),
      'Compact'
    )
    t.check(
      'the slider is labelled',
      !!(await win.getAttribute('[data-testid="density-slider"]', 'aria-label')),
      await win.getAttribute('[data-testid="density-slider"]', 'aria-label')
    )

    // ── Every metric moves, and only the metrics move ───────────────────────
    // Walk all five stops with Home/End and the arrows, and compare the whole
    // spec against the arithmetic at each one.
    await win.keyboard.press('Home')
    for (const [i, stop] of STOPS.entries()) {
      if (i > 0) await win.keyboard.press('ArrowRight')
      await until(
        async () => (await win.textContent('[data-testid="density-value"]')) === stop.label
      )
      const got = await win.evaluate(RESOLVE, ALL)
      const drifted = Object.entries(METRICS).filter(
        ([name, px]) => !near(got[name], px * stop.scale)
      )
      t.check(
        `${stop.label}: all ${Object.keys(METRICS).length} metrics scale by ${stop.scale}`,
        drifted.length === 0,
        drifted.map(([n, px]) => `${n}: expected ${px * stop.scale}, got ${got[n]}`)
      )
      const moved = Object.entries(FIXED).filter(([name, px]) => !near(got[name], px))
      t.check(
        `${stop.label}: the hairlines and --row-gap hold still`,
        moved.length === 0,
        moved.map(([n, px]) => `${n}: expected ${px}, got ${got[n]}`)
      )
      t.check(
        `${stop.label}: --density is written on the root element`,
        (await win.evaluate(() => document.documentElement.style.getPropertyValue('--density'))) ===
          String(stop.scale),
        await win.evaluate(() => document.documentElement.style.getPropertyValue('--density'))
      )
    }

    // ── A real control, not just the token ──────────────────────────────────
    // A token that scales while nothing is drawn from it is not a feature. The
    // settings page's own rows are the nearest real controls to hand.
    await win.keyboard.press('Home')
    await until(async () => (await win.textContent('[data-testid="density-value"]')) === 'Compact')
    const compactRow = await win.evaluate(
      () => document.querySelector('.settings-row-title')?.getBoundingClientRect().height
    )
    await win.keyboard.press('End')
    await until(async () => (await win.textContent('[data-testid="density-value"]')) === 'Spacious')
    const spaciousRow = await win.evaluate(
      () => document.querySelector('.settings-row-title')?.getBoundingClientRect().height
    )
    t.check('a real settings row is taller at Spacious than at Compact', spaciousRow > compactRow, {
      compactRow,
      spaciousRow
    })

    // ── A renderer label follows the spec, measured, not grepped ───────────
    // The round-1 review's defect 1: the renderer pinned the control's numbers
    // as Tailwind arbitrary values, so a Spacious 31.5px row kept a 13px name.
    // check-tokens.mjs now refuses the LITERAL `text-[13px]`, but a literal ban
    // only catches the number it knows — mutating that span to `text-[19px]`
    // slips straight past it, because 19 is not a number the spec owns. The
    // only check that cannot be dodged is measuring the rendered label against
    // the token at a non-default stop, which is what this does. The hook is a
    // data-testid rather than the class under test: swap the class for a
    // literal and the element is still found, and still wrong.
    await win.keyboard.press('End')
    await until(async () => (await win.textContent('[data-testid="density-value"]')) === 'Spacious')
    const spec = await win.evaluate(RESOLVE, ['--control-text'])
    const labelPx = await win.evaluate(() => {
      const el = document.querySelector('[data-testid="settings-nav-title"]')
      return el ? parseFloat(getComputedStyle(el).fontSize) : null
    })
    t.check(
      'the Settings nav label is drawn at --control-text, not a pinned literal',
      labelPx !== null && near(labelPx, spec['--control-text']),
      { labelPx, controlText: spec['--control-text'], stop: 'Spacious' }
    )
    t.check(
      'and it actually moved off the default stop value',
      labelPx !== null && !near(labelPx, 13),
      labelPx
    )

    // Nothing in the app's own chrome may still be sitting at the default
    // stop's 13px once the slider is at Spacious. The terminal is excluded by
    // the brief — its font size is the terminal's setting, not the chrome's.
    const stuck = await win.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .filter((el) => !el.closest('.xterm') && el.textContent?.trim())
        .filter((el) => Math.abs(parseFloat(getComputedStyle(el).fontSize) - 13) < 0.01)
        .slice(0, 8)
        .map((el) => ({
          cls: el.className?.toString?.().slice(0, 60),
          text: el.textContent.trim().slice(0, 30)
        }))
    )
    t.check('no chrome text is still pinned at 13px at Spacious', stuck.length === 0, stuck)

    // ── It survives a skin change ───────────────────────────────────────────
    // applySkin() clears the properties it wrote; --density is not one of them
    // and must still be standing afterwards, at the value the user picked.
    const skins = await win.evaluate(() => window.electronAPI.skinsList())
    const other = skins.skins.find((s) => s.id !== skins.activeId) ?? skins.skins[0]
    await win.evaluate((id) => window.electronAPI.skinsActivate(id), other.id)
    await until(
      async () => (await win.evaluate(() => window.electronAPI.skinsList())).activeId === other.id
    )
    const afterSkin = await win.evaluate(RESOLVE, ALL)
    t.equal(
      `--density survives activating the ${other.id} skin`,
      await win.evaluate(() => document.documentElement.style.getPropertyValue('--density')),
      '1.125'
    )
    t.check(
      'and the spec is still scaled after the skin change',
      near(afterSkin['--control-h'], 28 * 1.125),
      afterSkin['--control-h']
    )

    // ── It survives a restart ───────────────────────────────────────────────
    await app.close()
    ;({ app, win } = await launchApp(DIR))
    const afterRestart = await win.evaluate(RESOLVE, ALL)
    t.check(
      'Spacious is still in force after a restart',
      near(afterRestart['--control-h'], 28 * 1.125),
      afterRestart['--control-h']
    )
    await openDensity(win)
    t.equal(
      'and the slider reopens on the saved stop',
      await win.textContent('[data-testid="density-value"]'),
      'Spacious'
    )

    // ── A value that is not a stop is not a density ─────────────────────────
    // The saved id is read into a CSS length multiplier, so anything that is
    // not one of the five must fall back rather than be written through.
    await win.evaluate(() => localStorage.setItem('clave-density', 'enormous'))
    await app.close()
    ;({ app, win } = await launchApp(DIR))
    const afterGarbage = await win.evaluate(RESOLVE, ALL)
    t.equal(
      'a saved stop that no longer exists falls back to the default',
      await win.evaluate(() => document.documentElement.style.getPropertyValue('--density')),
      '1'
    )
    t.check(
      'and the spec is back at its written values',
      near(afterGarbage['--control-h'], 28),
      afterGarbage['--control-h']
    )

    // ── The session tab name, measured on a real tab ────────────────────────
    // The most-read text in the app, and the one place a pin hurts most. The
    // round-2 review put `text-[19px]` on it and BOTH gates stayed green: the
    // chrome sweep above only knows the number 13, and the audit only knows the
    // literals it lists. Only measuring the rendered name closes that.
    //
    // Booted straight into Spacious from localStorage rather than driven
    // through the UI: Settings replaces the sidebar with its own, so the tab is
    // not on screen while the slider is, and there is no toggle back out.
    await win.evaluate(() => localStorage.setItem('clave-density', 'spacious'))
    await app.close()
    ;({ app, win } = await launchApp(DIR))
    const atSpacious = await win.evaluate(RESOLVE, ['--control-text'])
    t.check(
      'the app booted into Spacious',
      near(atSpacious['--control-text'], 13 * 1.125),
      atSpacious['--control-text']
    )
    const spawned = await spawnAgentTabIn(app, win, DIR, { until })
    t.check('a session tab exists to measure', !!spawned, spawned)
    const tabName = await until(async () =>
      win.evaluate(() => {
        const el = document.querySelector('[data-testid="session-tab-name"]')
        return el ? parseFloat(getComputedStyle(el).fontSize) : null
      })
    )
    t.check(
      'the session tab name is drawn at --control-text, not a pinned literal',
      tabName !== null && near(tabName, atSpacious['--control-text']),
      { tabName, controlText: atSpacious['--control-text'], stop: 'Spacious' }
    )
  } finally {
    await app.close()
  }
}
