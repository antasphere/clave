import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * A press never moves or resizes a control (PRDCT-4538). A menu or popover is
 * anchored to its trigger's edge, so a trigger that dipped under the pointer
 * carried the open surface with it as it grew back on release: the menu landed,
 * then drifted. The fill is a control's feedback, never its size or its place.
 *
 * Every `:active` rule in the app's stylesheets is held to that: it may change
 * a colour or a fill, never a scale, a transform or a translate.
 */
const ROOT = new URL('../../../../', import.meta.url).pathname
const MOVES = /(^|[;\s{])(-webkit-)?(scale|transform|translate)\s*:/

function sheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (['node_modules', 'dist', 'out'].includes(name) || name.startsWith('.')) return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sheets(path)
    return name.endsWith('.css') ? [path] : []
  })
}

describe('a press holds the control still', () => {
  const files = ['src', 'packages', 'plugins'].flatMap((dir) => sheets(join(ROOT, dir)))
  it('finds the stylesheets', () => {
    expect(files.map((file) => relative(ROOT, file))).toContain('packages/ui/src/system.css')
  })
  it.each(files.map((file) => [relative(ROOT, file), file]))(
    '%s: no :active rule moves or resizes',
    (_, file) => {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      const moving = [...css.matchAll(/([^{}]*:active[^{}]*)\{([^{}]*)\}/g)]
        .filter((rule) => MOVES.test(rule[2]))
        .map((rule) => rule[1].trim())
      expect(moving).toEqual([])
    }
  )
})
