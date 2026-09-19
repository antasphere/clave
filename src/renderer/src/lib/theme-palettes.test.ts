import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { THEMES, DARK_THEMES, isDarkTheme, type Theme } from '../store/session-types'
import { getXtermTheme } from './terminal-theme'

/**
 * A theme is spread over four files that do NOT import each other — the name
 * list in `session-types.ts`, a `[data-theme]` block in `main.css`, an xterm
 * palette in `terminal-theme.ts`, and a swatch in the Appearance pane — and
 * every way they can disagree is silent. A theme with no CSS block inherits the
 * dark palette and merely looks wrong; a theme missing one token inherits that
 * one token from dark, which on a light skin is a black fill nobody chose; a
 * theme with no xterm palette used to fall through to LIGHT, so a dark skin got
 * a white terminal inside a dark card. Nothing throws in any of those cases.
 *
 * So this file re-derives the agreement from the sources themselves rather than
 * restating it: it parses main.css, and it compares against the ramp rather
 * than against a copy of the hexes. Repainting a theme freely is the point of a
 * skin — what must not change is that the four halves still describe the same
 * one.
 */

const CSS = readFileSync(fileURLToPath(new URL('../../../../packages/ui/src/tokens.css', import.meta.url)), 'utf-8')

/** Tokens that are deliberately CROSS-theme: user-setting knobs written as an
 *  inline style on the root element (which beats every stylesheet block), so
 *  the themes never own them and re-declaring them per theme would be copies
 *  of a constant. `--rule-intensity` is Appearance → Tree separators
 *  (AppShell sets it via `style.setProperty`). */
const CROSS_THEME_KNOBS = new Set(['--rule-intensity'])

/** The selector each theme's palette block is written under. Dark is the app's
 *  default and lives on bare `:root`; the others are attribute-scoped. */
function selectorFor(theme: Theme): string {
  return theme === 'dark' ? ':root' : `[data-theme="${theme}"]`
}

/** The custom properties declared inside one block, by brace matching — a regex
 *  across the whole file would happily read the next theme's declarations. */
function tokensOf(selector: string): Map<string, string> {
  const head = CSS.indexOf(`${selector} {`)
  if (head === -1) return new Map()
  let depth = 0
  let i = CSS.indexOf('{', head)
  const open = i
  for (; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}' && --depth === 0) break
  }
  const body = CSS.slice(open + 1, i)
  const out = new Map<string, string>()
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}

/** The tokens a value reads through `var()`. A property whose value is BUILT
 *  from other tokens — `color-mix(… var(--sidebar-icon-color) …)` — is a
 *  different animal from one holding a literal: substitution happens where it
 *  is used, against whatever the winning theme set those inputs to, so a theme
 *  that does not redeclare it still gets its own colour out of it. Declaring it
 *  per theme would be four copies of one expression, free to drift. */
function refsOf(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1])
}

/** Relative luminance, the WCAG definition — the objective half of "is this a
 *  dark theme", so the answer is measured off the paint instead of asserted. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

describe('theme palettes', () => {
  it('ships the four skins the app offers', () => {
    expect([...THEMES]).toEqual(['dark', 'charcoal', 'light', 'coffee'])
  })

  it.each([...THEMES])('%s declares a palette block in main.css', (theme) => {
    expect(tokensOf(selectorFor(theme)).size).toBeGreaterThan(0)
  })

  it.each([...THEMES])('%s declares every token the default theme declares', (theme) => {
    // Whatever a theme leaves out, it silently inherits from the dark block —
    // which is a plausible-looking value on another dark skin and a hole in the
    // paint on a light one. Either way nothing reports it.
    // Derived tokens are exempt, and only they: they cannot go stale, because
    // they are re-resolved per theme from inputs the theme DOES declare — which
    // the test below is what guarantees.
    const declared = tokensOf(selectorFor(theme))
    const root = tokensOf(':root')
    const missing = [...root.entries()]
      .filter(([, v]) => refsOf(v).length === 0)
      .map(([t]) => t)
      .filter((t) => !declared.has(t) && !CROSS_THEME_KNOBS.has(t))
    expect(missing).toEqual([])
  })

  it.each([...THEMES])('%s declares the inputs every derived token reads', (theme) => {
    // The exemption above is only sound while a derived token's inputs are
    // themselves per-theme. Let one of those inputs go missing and the derived
    // value inherits dark's through the back door — the same hole in the paint,
    // one level down, and nothing else would report it.
    const declared = tokensOf(selectorFor(theme))
    const root = tokensOf(':root')
    const dangling = [...root.values()]
      .flatMap(refsOf)
      .filter((ref) => root.has(ref) && !declared.has(ref) && !CROSS_THEME_KNOBS.has(ref))
    expect([...new Set(dangling)]).toEqual([])
  })

  it.each([...THEMES])('%s paints its terminal on its own card surface', (theme) => {
    // The terminal card is --surface-0 in CSS while xterm paints its own
    // background from the palette object. When the two disagree the card shows
    // a seam of the wrong colour around live output — which is exactly what a
    // theme with no palette of its own does, by falling through to another's.
    const surface0 = tokensOf(selectorFor(theme)).get('--surface-0')
    expect(getXtermTheme(theme).background.toLowerCase()).toBe(surface0?.toLowerCase())
  })

  it.each([...THEMES])('%s is filed light or dark according to what it measures', (theme) => {
    // isDarkTheme drives the source highlighter and every other light/dark
    // branch, and it is a hand-kept list. Checked against the ramp it names, so
    // a skin filed on the wrong side is a red test rather than github-light
    // source code on a charcoal panel.
    const surface0 = tokensOf(selectorFor(theme)).get('--surface-0') ?? '#000000'
    expect(isDarkTheme(theme)).toBe(luminance(surface0) < 0.2)
  })

  it('gives every theme a palette of its own', () => {
    const backgrounds = THEMES.map((t) => getXtermTheme(t).background)
    expect(new Set(backgrounds).size).toBe(THEMES.length)
  })

  it('keeps the dark family a subset of the themes on offer', () => {
    expect(DARK_THEMES.every((t) => (THEMES as readonly string[]).includes(t))).toBe(true)
  })
})
