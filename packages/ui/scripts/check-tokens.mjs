/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')
const css = read('../src/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '')
const app = read('../../../src/renderer/src/assets/main.css').replace(/\/\*[\s\S]*?\*\//g, '')
const overrides = JSON.parse(read('./expected-theme-overrides.json'))
const expected = JSON.parse(read('./expected-tokens.json'))
const declarations = (body) => new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
const block = (source, selector) => {
  const start = source.indexOf(selector)
  assert(start >= 0, `Missing ${selector}`)
  const open = source.indexOf('{', start)
  return declarations(source.slice(open + 1, source.indexOf('}', open)))
}
const system = read('../src/system.css').replace(/\/\*[\s\S]*?\*\//g, '')
const tailwind = read('../../../node_modules/tailwindcss/theme.css')
const declared = declarations([css, app, system, tailwind].join('\n'))
// The field's accent is supplied by BrandField at runtime, not by a skin.
declared.add('--field-accent')
// Radix Popper measures these and declares them inline on the menu content.
declared.add('--radix-dropdown-menu-trigger-width')
declared.add('--radix-dropdown-menu-content-available-height')
for (const source of [css, app, system]) {
  for (const match of source.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
    assert(declared.has(match[1]), `Undefined CSS variable without fallback: ${match[1]}`)
  }
}
const shared = block(css, '@theme')
const root = block(css, ':root')
for (const theme of ['dark', 'light', 'coffee', 'charcoal']) {
  const local = block(css, `[data-theme="${theme}"]`)
  const cm = block(app, `[data-theme="${theme}"]`)
  for (const name of expected) {
    assert(
      name.startsWith('--cm-')
        ? cm.has(name)
        : local.has(name) || root.has(name) || shared.has(name),
      `${theme} lost ${name}`
    )
  }
  // A themed override disappearing must not silently fall back to dark.
  for (const name of overrides[theme])
    assert(
      name.startsWith('--cm-') ? cm.has(name) : local.has(name),
      `${theme} lost its override of ${name}`
    )
}
assert(
  !/@layer\b/.test(read('../src/system.css').replace(/\/\*[\s\S]*?\*\//g, '')),
  'System classes must remain unlayered'
)

/* ── The density audit ───────────────────────────────────────────────────────
 *
 * Every metric the chrome is measured in is a calc() cut from --density, so one
 * Appearance slider resizes the whole control and frame spec together. Both
 * halves of that sentence fail SILENTLY when they stop being true, which is the
 * only reason this runs in CI rather than being eyeballed:
 *
 *  - a token that stops deriving from --density keeps its default value, so the
 *    app looks perfect until someone moves the slider and one family of
 *    controls stays behind while the rest resize around it;
 *  - a component that restates a number the spec already owns (font-size: 13px
 *    instead of var(--control-text)) is invisible at the default stop — it IS
 *    13px there — and only shows as a label that will not shrink.
 *
 * Neither throws, neither warns, and neither shows up in a screenshot of the
 * default. So they are asserted.
 */
/** token -> its declared value, across every block of tokens.css. The spec
 *  lives in @theme and the themes restate colours below it; a later block wins,
 *  which is the cascade's own answer and the one the browser will give. */
const values = new Map(
  [...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
)

/** Does this token reach --density, through however many var() hops? */
const scales = (name, seen = new Set()) => {
  if (name === '--density') return true
  if (seen.has(name)) return false
  seen.add(name)
  const value = values.get(name)
  if (value === undefined) return false
  return [...value.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].some((m) => scales(m[1], seen))
}

// The chrome's metrics: a stop on the slider must move every one of them.
for (const name of [
  '--control-h',
  '--control-h-xs',
  '--control-h-sm',
  '--control-h-md',
  '--control-h-lg',
  '--control-px',
  '--control-gap',
  '--control-text',
  '--control-icon',
  '--control-radius',
  '--frame-h',
  '--frame-radius',
  '--framed-control-h',
  '--framed-control-radius',
  '--framed-control-icon',
  '--radius',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--radius-2xl',
  '--radius-control',
  '--surface-inset',
  '--toolbar-h',
  '--toolbar-row-h',
  '--content-top-offset',
  '--sidebar-row-h',
  '--sidebar-row-px',
  '--sidebar-tab-icon-size',
  '--sidebar-gutter',
  '--panel-row-h',
  '--git-tree-row-h'
]) {
  assert(values.has(name), `${name} is no longer declared in tokens.css`)
  assert(scales(name), `${name} does not derive from --density: the slider will not move it`)
}

// And the ones that must NOT move. A hairline is a hairline at every density,
// a pill is a pill, and --row-gap is skinnable, so a var(--density) in it is
// extracted into every bundled skin.json and then refused by validateTokens.
for (const name of ['--frame-border', '--frame-inset', '--radius-full', '--row-gap']) {
  assert(values.has(name), `${name} is no longer declared in tokens.css`)
  assert(!scales(name), `${name} must not derive from --density`)
}

// --density is the user's, never a skin's: it is on the skins' excluded list
// with the rest of the metrics, so an installed skin cannot reach it.
assert(
  JSON.parse(read('../../skins/excluded-token-names.json')).includes('--density'),
  '--density must stay on packages/skins/excluded-token-names.json'
)

/* No component may restate a number the spec already owns. Keyed by property,
 * because the same length means different things in different places: 14px is
 * the framed control's GLYPH and also a perfectly ordinary line-height. */
const SPEC_LITERALS = {
  'font-size': { '13px': '--control-text' },
  height: {
    '1.25rem': '--control-h-xs',
    '20px': '--control-h-xs',
    '1.5rem': '--control-h-sm',
    '24px': '--control-h-sm',
    '1.75rem': '--control-h-md',
    '28px': '--control-h-md',
    '2rem': '--control-h-lg',
    '32px': '--control-h-lg'
  }
}
SPEC_LITERALS['min-height'] = SPEC_LITERALS.height
/* Deliberate exceptions, each one a shape that is not a control:
 *  - .theme-swatch-* are the Appearance page's miniature of a whole window.
 *    Its tiles are a drawing of an app, not controls in one, and tying them to
 *    the control scale would make the picture of the app resize with the app.
 *  - .range-field's own track and thumb are declared as its custom properties
 *    at the top of the rule; the numbers there are the slider's anatomy. */
const NOT_A_CONTROL = /^\.(theme-swatch|range-field|range-tick)/
for (const [, selector, body] of system.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const name = selector.trim()
  if (NOT_A_CONTROL.test(name)) continue
  for (const [, prop, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    const token = SPEC_LITERALS[prop.trim()]?.[value.trim()]
    assert(
      !token,
      `${name} pins ${prop.trim()}: ${value.trim()}, a number the control spec owns — ` +
        `use var(${token}) so it moves with --density`
    )
  }
}

console.log(
  `All ${expected.length} baseline tokens resolve in all four themes (CodeMirror remains app-owned).`
)
console.log('The control and frame spec derives from --density, and no system class bypasses it.')
