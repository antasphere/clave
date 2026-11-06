import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DRAWINGS } from '../page/drawings'

/** The page's drawings are page/drawings/*.svg (the skill's assets) without their
 *  standalone stylesheet; the two must not drift. */
describe('the analytics drawings', () => {
  it.each([
    ['workspace', 'home'],
    ['group', 'group'],
    ['session', 'session']
  ] as const)('%s is the markup of %s.svg', (kind, file) => {
    const svg = readFileSync(join(__dirname, '..', 'page', 'drawings', `${file}.svg`), 'utf8')
    const stripped = svg.replace(/\s*<style>[\s\S]*?<\/style>/, '')
    const inner = stripped
      .slice(stripped.indexOf('>', stripped.indexOf('<svg')) + 1, stripped.lastIndexOf('</svg>'))
      .split('\n')
      .filter((line) => line.trim())
      .join('\n')
    expect(DRAWINGS[kind].trim()).toBe(inner.trim())
  })
  it('uses the accent exactly once per drawing', () => {
    for (const markup of Object.values(DRAWINGS))
      expect(markup.match(/class="ln ln--c travel"/g)?.length).toBe(1)
  })
})
