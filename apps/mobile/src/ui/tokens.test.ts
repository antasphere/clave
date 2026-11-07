import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  oklchToHex,
  normalizeColor,
  renderTokensModule,
  tokensFromCss
} from '../../scripts/tokens-from-css.mjs'
import { FONT_WEIGHT_MEDIUM, SHARED_COLORS, THEME_COLORS, THEME_NAMES } from './tokens.generated'

/* The phone's colour roles are the desktop's, read from
   packages/ui/src/tokens.css and written once into tokens.generated.ts.
   This test regenerates the module from the stylesheet as it is now and
   holds the committed module to it: a token the desktop changes without
   `npm run tokens` on the phone fails here, named. */

const here = path.dirname(new URL(import.meta.url).pathname)
const css = readFileSync(
  path.resolve(here, '..', '..', '..', '..', 'packages', 'ui', 'src', 'tokens.css'),
  'utf8'
)
const committed = readFileSync(path.resolve(here, 'tokens.generated.ts'), 'utf8')

describe('tokens.generated.ts', () => {
  it('is exactly what tokens.css generates today', () => {
    expect(renderTokensModule(tokensFromCss(css))).toBe(committed)
  })

  it('carries the four themes with every role a literal colour', () => {
    expect([...THEME_NAMES]).toEqual(['dark', 'light', 'coffee', 'charcoal'])
    for (const theme of THEME_NAMES)
      for (const [role, value] of Object.entries(THEME_COLORS[theme]))
        expect(value, `${theme}.${role}`).toMatch(/^(#[0-9a-f]{6}|rgba\([\d., ]+\))$/)
    expect(SHARED_COLORS.destructive).toBe('#ef4444')
    expect(FONT_WEIGHT_MEDIUM).toBe(400)
  })

  it('reads the dark theme off :root and the others off their data-theme block', () => {
    expect(THEME_COLORS.dark.surface0).toBe('#0e0d0c')
    expect(THEME_COLORS.light.surface0).toBe('#fbfbf9')
    expect(THEME_COLORS.coffee.accent).toBe('#1f5bc4')
    expect(THEME_COLORS.charcoal.textPrimary).toBe('#efece9')
    // The rule hairline is composed from the theme's rgb and alpha.
    expect(THEME_COLORS.light.rule).toBe('rgba(0, 0, 0, 0.022)')
  })
})

describe('normalizeColor', () => {
  it('rewrites the syntaxes the phone cannot read and refuses a derived value', () => {
    expect(normalizeColor('rgb(0 0 0 / 0.4)', 'x')).toBe('rgba(0, 0, 0, 0.4)')
    expect(normalizeColor('rgba(255, 255, 255, 0.1)', 'x')).toBe('rgba(255, 255, 255, 0.1)')
    expect(normalizeColor('#FFFFFF', 'x')).toBe('#ffffff')
    expect(() => normalizeColor('color-mix(in srgb, red 50%, blue)', 'x')).toThrow(/--x/)
    expect(() => normalizeColor('var(--accent)', 'x')).toThrow(/--x/)
  })

  it('converts oklch to sRGB (white, black, the Terminal view model violet)', () => {
    expect(oklchToHex(1, 0, 0)).toBe('#ffffff')
    expect(oklchToHex(0, 0, 0)).toBe('#000000')
    expect(normalizeColor('oklch(0.62 0.2 300)', 'x')).toBe('#9b61ea')
  })
})
