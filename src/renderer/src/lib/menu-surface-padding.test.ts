import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A menu's rows never touch its border. `.menu-surface` is the frame (radius,
 * border, ground, shadow) and deliberately carries no padding, because its
 * users need different insides: a menu, a card, a document-sized sheet. So
 * every element that wears it must get its padding from somewhere, and a
 * call site that forgets it renders its rows flush against the edge — the
 * view picker and the merge-method menu both did, built on raw Radix instead
 * of the shared DropdownMenuContent, which pads itself.
 *
 * Every class list in the code that names `menu-surface` must therefore also
 * name a padding source: a `p-*` / `px-*` / `py-*` utility, a class whose rule
 * in the stylesheets declares padding, or `menu-surface--sheet`, the
 * document-sized tier whose content pads itself.
 */
const ROOT = new URL('../../../../', import.meta.url).pathname
// The design system, and the app's own sheet for the few surfaces styled there.
const css = ['packages/ui/src/system.css', 'src/renderer/src/assets/main.css']
  .map((file) => readFileSync(join(ROOT, file), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const padded = new Set(
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /(^|;|\s)padding(-[a-z-]+)?\s*:/m.test(m[2]))
    .flatMap((m) => [...m[1].matchAll(/\.([\w-]+)/g)].map((c) => c[1]))
)
const SHEET = 'menu-surface--sheet'
const UTILITY = /^!?p[xytblr]?-/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.') || name === 'out') return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : []
  })
}

describe('menu surfaces', () => {
  const offenders: string[] = []
  const files = ['src', 'plugins', 'packages'].flatMap((dir) => sources(join(ROOT, dir)))
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const literal of text.matchAll(/(['"`])([^'"`]*\bmenu-surface\b[^'"`]*)\1/g)) {
      const classes = literal[2].split(/\s+/).filter(Boolean)
      // A comment or a selector naming the class is not a class list.
      if (!classes.includes('menu-surface')) continue
      const ok =
        classes.includes(SHEET) ||
        classes.some((c) => UTILITY.test(c) || (c !== 'menu-surface' && padded.has(c)))
      if (!ok) offenders.push(`${file.replace(ROOT, '')}: "${literal[2]}"`)
    }
  }
  it('always carry padding, so no row touches the border', () => {
    expect(files.length).toBeGreaterThan(50)
    expect(offenders).toEqual([])
  })
})
