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
console.log(
  `All ${expected.length} baseline tokens resolve in all four themes (CodeMirror remains app-owned).`
)
