/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = path.dirname(fileURLToPath(import.meta.url))
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
 * Appearance → Density picks a preset: tokens.css holds Compact, and each block
 * of density.css restates the tokens that differ as literals. Three things fail
 * SILENTLY when they stop being true, so they are asserted:
 *
 *  - a preset naming a token tokens.css does not declare sets nothing anyone
 *    reads — a typo'd name leaves that preset drawing Compact's value;
 *  - a preset setting a DERIVED frame token breaks the concentric-corner
 *    arithmetic tokens.css does from --frame-h, --frame-inset, --frame-radius;
 *  - a preset token a skin can reach would let an installed skin override the
 *    user's density, so every one is on the skins' excluded list.
 */
/** token -> its declared value, across every block of tokens.css. */
const values = new Map(
  [...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
)
const densityCss = read('../src/density.css').replace(/\/\*[\s\S]*?\*\//g, '')
const presets = [...densityCss.matchAll(/data-density='([\w-]+)'\]\s*\{([^}]*)\}/g)]
assert(
  JSON.stringify(presets.map((m) => m[1])) ===
    JSON.stringify(['tight', 'balanced', 'comfortable', 'spacious']),
  `density.css must hold tight, balanced, comfortable and spacious (compact is tokens.css), got ${presets.map((m) => m[1])}`
)
const excluded = JSON.parse(read('../../skins/excluded-token-names.json'))
const DERIVED = ['--framed-control-h', '--framed-control-radius', '--toolbar-h', '--toolbar-row-h']
for (const [, preset, body] of presets) {
  for (const [, name] of body.matchAll(/(--[\w-]+)\s*:/g)) {
    assert(
      values.has(name),
      `density.css ${preset} sets ${name}, which tokens.css does not declare`
    )
    assert(
      !DERIVED.includes(name),
      `density.css ${preset} sets ${name}: it is derived, set its inputs`
    )
    assert(
      excluded.includes(name),
      `${name} (density.css ${preset}) must be on packages/skins/excluded-token-names.json`
    )
  }
}
assert(
  excluded.includes('--ui-text-offset'),
  '--ui-text-offset must be on packages/skins/excluded-token-names.json'
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
    '32px': '--control-h-lg',
    /* The foot panel's own shape (defect 2 of the round-1 review): a row
       written as "the control plus its air" and then frozen as one number.
       34px is --control-h-md + 6, 40px is --control-h-lg + 8; both belong in
       a calc() that names the control, so the air survives the scale. */
    '2.125rem': '--control-h-md (+ its air)',
    '34px': '--control-h-md (+ its air)',
    '2.5rem': '--control-h-lg (+ its air)',
    '40px': '--control-h-lg (+ its air)'
  }
}
SPEC_LITERALS['min-height'] = SPEC_LITERALS.height
/* Deliberate exceptions, each one a shape that is not a control:
 *  - .theme-swatch-* are the Appearance page's miniature of a whole window.
 *    Its tiles are a drawing of an app, not controls in one, and tying them to
 *    the control scale would make the picture of the app resize with the app.
 *  - .range-field's own track and thumb are declared as its custom properties
 *    at the top of the rule; the numbers there are the slider's anatomy. */
const NOT_A_CONTROL = /^\.(theme-swatch|range-field|range-tick|range-rail|range-dot|range-stepped)/
for (const [, selector, body] of system.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const name = selector.trim()
  if (NOT_A_CONTROL.test(name)) continue
  for (const [, prop, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    const token = SPEC_LITERALS[prop.trim()]?.[value.trim()]
    assert(
      !token,
      `${name} pins ${prop.trim()}: ${value.trim()}, a number the control spec owns — ` +
        `use var(${token}) so it follows the density presets`
    )
  }
}

/* ── The same rule, one directory over ───────────────────────────────────────
 *
 * The check above reads system.css. The round-1 review of PR #69 showed that is
 * where the labels are NOT: the renderer pinned the control spec's numbers in
 * 44 places as Tailwind arbitrary values — `text-[13px]` on the session tab
 * name, the sidebar's section labels, the group name — so a Spacious 31.5px row
 * kept a 13px name in it. Mutating the session name to `text-[19px]` left the
 * whole suite green, audit included: a 6px jump in the most-read text in the
 * app, invisible to every check.
 *
 * The literal is not wrong at the default stop — it IS 13px there. That is what
 * makes it worth a gate rather than a review comment: it looks right in every
 * screenshot and only fails once somebody moves the slider.
 *
 * Deliberately narrow. It refuses the arbitrary-value forms that restate the
 * spec's own numbers, not every length in the renderer — `h-4` icons, `text-xs`
 * captions and the rest are Tailwind's scale doing its job, and dragging them in
 * would make this noise nobody reads. The terminal and plugins/ are out of scope
 * by the brief; this only walks src/renderer/src.
 */
const RENDERER = path.join(dir, '../../../src/renderer/src')
/* Each pattern: what a component must not write, and what to write instead. */
const RENDERER_LITERALS = [
  [/\btext-\[13px\]/, 'text-[13px]', 'text-control (font-size: var(--control-text))'],
  [/\btext-\[length:13px\]/, 'text-[length:13px]', 'text-control'],
  [/\bh-\[28px\]/, 'h-[28px]', 'h-control-md (height: var(--control-h-md))'],
  [/\bh-\[24px\]/, 'h-[24px]', 'h-control-sm'],
  [/\bh-\[20px\]/, 'h-[20px]', 'h-control-xs'],
  [/\bh-\[32px\]/, 'h-[32px]', 'h-control-lg']
]
const walk = (folder) =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : []
  })
/* Tailwind's NAMED scale lands on the same four numbers: h-5/6/7/8 are
 * 20/24/28/32px, the control ladder exactly. `h-[28px]` and `h-7` freeze a row
 * identically, so refusing only the arbitrary form would leave the easier
 * spelling wide open.
 *
 * The allow-list is a SHAPE, not a file list: a square box (`w-6 h-6`) is an
 * icon, an avatar or an image, and none of those is a control. An icon that
 * happens to be 20px is not the xs control, and the sidebar foot's avatar is a
 * fixed canvas that would need a re-render rather than a class. A bare `h-7`
 * with no matching width is a row, a button or a field, and those follow the
 * spec. */
const NAMED_HEIGHTS = {
  5: '--control-h-xs',
  6: '--control-h-sm',
  7: '--control-h-md',
  8: '--control-h-lg'
}
const CLASS_SUFFIX = { 5: 'xs', 6: 'sm', 7: 'md', 8: 'lg' }
for (const file of walk(RENDERER)) {
  const source = readFileSync(file, 'utf8')
  const where = path.relative(path.join(dir, '../../..'), file)
  for (const [pattern, literal, instead] of RENDERER_LITERALS) {
    const line = source.split('\n').findIndex((l) => pattern.test(l))
    assert(
      line === -1,
      `${where}:${line + 1} pins ${literal}, ` +
        `a number the control spec owns — use ${instead} so it follows the density presets`
    )
  }
  source.split('\n').forEach((text, i) => {
    for (const [n, token] of Object.entries(NAMED_HEIGHTS)) {
      if (!new RegExp(`(?<![\\w-])h-${n}(?![\\w-])`).test(text)) continue
      // Square box on the same line => an icon, an avatar or an image.
      if (new RegExp(`(?<![\\w-])w-${n}(?![\\w-])`).test(text)) continue
      assert(
        false,
        `${where}:${i + 1} pins h-${n}, a control height the spec owns — use ` +
          `h-control-${CLASS_SUFFIX[n]} (height: var(${token})) so it follows the density presets, ` +
          `or pair it with w-${n} if it is an icon box rather than a control`
      )
    }
  })
}

console.log(
  `All ${expected.length} baseline tokens resolve in all four themes (CodeMirror remains app-owned).`
)
console.log(
  'The density presets are declared, skin-proof and never set a derived token; neither system.css nor the renderer restates the spec.'
)
