/**
 * Appearance → Density and Text size.
 *
 * Density is one of five presets written on the root element as data-density
 * (packages/ui/src/density.css). Two of them reproduce hand-tuned designs
 * exactly — Compact is the 2026-09-21 spec, Comfortable the chrome as tuned
 * before it — and those numbers were measured on the real builds of each, so
 * they are asserted here as the COMPUTED lengths the live document resolves,
 * not as the stylesheet's text. Text size adds a px offset to the labels.
 *
 * Everything here fails silently in the app: an id no preset block matches
 * draws Compact without a word, a skin change that wiped the attribute would
 * reset the user's density, and a preset that sets the wrong token only shows
 * as one family of controls staying behind. Hence the measurements.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
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

/** Each preset's resolved lengths, in px. Compact and Comfortable are the
 *  measured designs; the three others are derived from them. Mirrored here on
 *  purpose: a spec that imported the table it checks would agree with itself. */
const PRESETS = [
  {
    id: 'tight',
    label: 'Tight',
    frame: 26,
    framed: 22,
    frameR: 5,
    framedR: 3,
    xl: 11,
    row: 26,
    textSm: 13
  },
  {
    id: 'compact',
    label: 'Compact',
    frame: 28,
    framed: 24,
    frameR: 6,
    framedR: 4,
    xl: 11,
    row: 28,
    textSm: 13
  },
  {
    id: 'balanced',
    label: 'Balanced',
    frame: 32,
    framed: 26,
    frameR: 8,
    framedR: 5,
    xl: 10.5,
    row: 30,
    textSm: 12.5
  },
  {
    id: 'comfortable',
    label: 'Comfortable',
    frame: 34,
    framed: 28,
    frameR: 10,
    framedR: 7,
    xl: 10,
    row: 32,
    textSm: 12
  },
  {
    id: 'spacious',
    label: 'Spacious',
    frame: 36,
    framed: 30,
    frameR: 12,
    framedR: 9,
    xl: 12,
    row: 34,
    textSm: 12
  }
]
const TOKENS = {
  frame: '--frame-h',
  framed: '--framed-control-h',
  frameR: '--frame-radius',
  framedR: '--framed-control-radius',
  xl: '--radius-xl',
  row: '--sidebar-row-h',
  textSm: '--control-text-sm'
}

/** Resolve custom properties to the px the engine computes: each one is put
 *  on a probe element's width and read back off the box. */
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
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.02
const drift = (got, preset) =>
  Object.entries(TOKENS)
    .filter(([key, name]) => !near(got[name], preset[key]))
    .map(([key, name]) => `${name}: expected ${preset[key]}, got ${got[name]}`)

async function openDensity(win) {
  await win.click('.sidebar-footer-btn[aria-label="Settings"]')
  await win.click('[data-settings-nav-row="appearance"]')
  await win.waitForSelector('[data-testid="density-slider"]')
}
const label = (win) => win.textContent('[data-testid="density-value"]')
const attr = (win) => win.evaluate(() => document.documentElement.dataset.density)

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  let { app, win } = await launchApp(DIR)
  try {
    await openDensity(win)

    // ── The default is Comfortable ──────────────────────────────────────────
    t.equal('the app opens on Comfortable', await attr(win), 'comfortable')
    t.equal('the slider names it', await label(win), 'Comfortable')
    t.equal('on the fourth stop', await win.inputValue('[data-testid="density-slider"]'), '3')

    // ── Every preset resolves to its table, driven from the keyboard ────────
    await win.focus('[data-testid="density-slider"]')
    await win.keyboard.press('Home')
    for (const [i, preset] of PRESETS.entries()) {
      if (i > 0) await win.keyboard.press('ArrowRight')
      await until(async () => (await label(win)) === preset.label)
      t.equal(`${preset.label}: data-density is written`, await attr(win), preset.id)
      const wrong = drift(await win.evaluate(RESOLVE, Object.values(TOKENS)), preset)
      t.check(`${preset.label}: every token resolves to the table`, wrong.length === 0, wrong)
      t.equal(
        `${preset.label}: the slider names the stop for a screen reader`,
        await win.getAttribute('[data-testid="density-slider"]', 'aria-valuetext'),
        preset.label
      )
    }

    // ── A real control, not just the token ──────────────────────────────────
    // The toolbar's icon buttons sit in a frame, so they are the framed
    // control: 28px at Comfortable, 24px at Compact, as measured on both builds.
    const toolbarButton = () =>
      win.evaluate(
        () => document.querySelector('.frame .btn-icon-md')?.getBoundingClientRect().height ?? null
      )
    await win.keyboard.press('Home')
    await win.keyboard.press('ArrowRight')
    await until(async () => (await label(win)) === 'Compact')
    t.check(
      'Compact: a toolbar button is 24px',
      near(await toolbarButton(), 24),
      await toolbarButton()
    )
    await win.keyboard.press('ArrowRight')
    await win.keyboard.press('ArrowRight')
    await until(async () => (await label(win)) === 'Comfortable')
    t.check(
      'Comfortable: a toolbar button is 28px',
      near(await toolbarButton(), 28),
      await toolbarButton()
    )

    // ── Text size adds to the preset's own sizes ────────────────────────────
    const navText = () =>
      win.evaluate(() => {
        const el = document.querySelector('.sidebar-item')
        return el ? parseFloat(getComputedStyle(el).fontSize) : null
      })
    t.check(
      'Comfortable: a sidebar row is 13.5px at Default',
      near(await navText(), 13.5),
      await navText()
    )
    await win.click('[data-text-size="largest"]')
    await until(async () => near(await navText(), 15.5))
    t.check('Largest adds 2px', near(await navText(), 15.5), await navText())
    t.check(
      'and moves the small labels too',
      near((await win.evaluate(RESOLVE, ['--control-text-sm']))['--control-text-sm'], 14)
    )
    await win.click('[data-text-size="default"]')

    // ── It survives a skin change ───────────────────────────────────────────
    const skins = await win.evaluate(() => window.electronAPI.skinsList())
    const other = skins.skins.find((s) => s.id !== skins.activeId) ?? skins.skins[0]
    await win.evaluate((id) => window.electronAPI.skinsActivate(id), other.id)
    await until(
      async () => (await win.evaluate(() => window.electronAPI.skinsList())).activeId === other.id
    )
    t.equal(`the preset survives activating the ${other.id} skin`, await attr(win), 'comfortable')

    // ── It survives a restart ───────────────────────────────────────────────
    await win.focus('[data-testid="density-slider"]')
    await win.keyboard.press('End')
    await until(async () => (await label(win)) === 'Spacious')
    await app.close()
    ;({ app, win } = await launchApp(DIR))
    t.equal('Spacious is still in force after a restart', await attr(win), 'spacious')

    // ── An id that is not a preset is not a density ─────────────────────────
    await win.evaluate(() => localStorage.setItem('clave-density-preset', 'enormous'))
    await app.close()
    ;({ app, win } = await launchApp(DIR))
    t.equal(
      'a saved id that is not a preset falls back to Comfortable',
      await attr(win),
      'comfortable'
    )

    // ── The old multiplier slider's stop is migrated ────────────────────────
    // Its `regular` (scale 1) was the 2026-09-21 spec: that is Compact now.
    await win.evaluate(() => {
      localStorage.removeItem('clave-density-preset')
      localStorage.setItem('clave-density', 'regular')
    })
    await app.close()
    ;({ app, win } = await launchApp(DIR))
    t.equal("the old slider's Regular opens as Compact", await attr(win), 'compact')
    const wrong = drift(await win.evaluate(RESOLVE, Object.values(TOKENS)), PRESETS[1])
    t.check('and draws Compact exactly', wrong.length === 0, wrong)
  } finally {
    await app.close()
  }
}
