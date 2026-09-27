import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Filled rows never touch. Every full-width class in the design system that
 * paints a hover fill is a row family, and each one must declare the air to
 * its predecessor through the "Row rhythm" selector, so that a hovered row
 * beside a selected one cannot fuse into one blob — the defect that came back
 * with every new list until the row, not the call site, owned the gap.
 */
const css = readFileSync(
  new URL('../../../../packages/ui/src/system.css', import.meta.url),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '')
// Top-level rules only: selector → declaration text.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim(),
  body: m[2]
}))
const declares = (body: string, property: string, value: RegExp): boolean =>
  new RegExp(`(^|;|\\s)${property}\\s*:\\s*${value.source}`, 'm').test(body)
const families = rules
  .filter(
    (r) => /^\.[\w-]+$/.test(r.selector) && declares(r.body, 'width', /100%/)
  )
  .map((r) => r.selector.slice(1))
  .filter((name) =>
    rules.some(
      (r) =>
        new RegExp(`\\.${name}(:hover|\\[data-highlighted\\])`).test(r.selector) &&
        declares(r.body, 'background-color', /./)
    )
  )
// Menus space their rows through --menu-row-gap, which is --row-gap except at
// the density presets that stack menu rows flush (packages/ui/src/density.css).
const rhythm = rules.filter((r) => declares(r.body, 'margin-top', /var\(--(?:menu-)?row-gap\)/))
// Full-width with a hover fill, but never two in a row: one "add" action at the
// foot of a card. Listing one here is a claim that it never stacks.
const SOLITARY = ['btn-add', 'settings-row-action']

describe('row rhythm', () => {
  it('finds the row families the system paints a hover fill on', () => {
    expect(families).toEqual(expect.arrayContaining(['menu-item', 'sidebar-item']))
  })
  it('spaces every fill-row family from its predecessor by --row-gap', () => {
    const missing = families.filter(
      (name) =>
        !SOLITARY.includes(name) &&
        !rhythm.some((r) => new RegExp(`\\.${name}\\b[^,]*\\+[^,]*\\.${name}\\b`).test(r.selector))
    )
    expect(missing).toEqual([])
  })
})
