import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The conversation view's motion, held to the design-engineering rules it was
 * built on: every arriving thing settles in rather than pops (@starting-style,
 * opacity and translate only, so the scroller's pin measures the same
 * heights); every button acknowledges a press with the shared dip; a surface
 * grows from the point that opened it; and reduced motion keeps the fades and
 * drops the travel. Each assertion goes red when the rule it names is deleted.
 */
// The block is marked by a comment, so it is found before the comments go.
const chat = readFileSync(
  new URL('../../../../packages/ui/src/system.css', import.meta.url),
  'utf8'
)
  .split('/* ── Conversation views')[1]
  .replace(/\/\*[\s\S]*?\*\//g, '')
const reduced = chat.slice(chat.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
/** The declaration block of the first rule whose selector list is `selector`. */
const block = (selector: string, source = chat): string => {
  const at = source.indexOf(`${selector} {`)
  expect(at, `${selector} is styled`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i)
  }
  throw new Error(`unterminated rule ${selector}`)
}
const ARRIVALS = [
  '.chat-column > *',
  '.chat-row[data-arrive] > *',
  '.chat-row[data-arrive] .term-turn > *',
  '.chat-prompt',
  '.chat-composer-files .chat-attachment'
]
const PRESSED = ['.chat-jump-end', '.chat-turn-copy', '.chat-composer-tool', '.chat-model-trigger']

describe('chat motion', () => {
  it.each(ARRIVALS)('%s settles in from a starting style, off the layout', (selector) => {
    const body = block(selector)
    expect(body).toMatch(/@starting-style\s*\{[^}]*opacity:\s*0/)
    expect(body).toMatch(/transition:[^;]*opacity/)
    // Never a layout property: the transcript's pin to its end reads heights.
    expect(body).not.toMatch(/transition:[^;]*(height|margin|padding)/)
  })
  it('the drop overlay comes up rather than snapping over the pane', () => {
    expect(block('.chat-drop-overlay')).toMatch(/@starting-style\s*\{[^}]*opacity:\s*0/)
  })
  it.each(PRESSED)('%s dips on press', (selector) => {
    expect(chat).toMatch(
      new RegExp(
        `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:active[^{]*\\{[^}]*scale:\\s*0\\.9\\d`
      )
    )
    expect(block(selector)).toMatch(/transition:[^;]*scale/)
  })
  it('the jump control rises from the foot it sits over, not from a menu origin', () => {
    expect(block('.chat-jump-end')).toMatch(/animation:\s*chat-rise/)
    expect(block('@keyframes chat-rise')).toMatch(/translate:\s*0\s+calc/)
  })
  it('a tool row reveals what it opens to, on every opening', () => {
    expect(chat).toMatch(/details\[open\] > \.chat-tool-panel \{[^}]*animation:\s*chat-reveal/)
  })
  it('send and stop are one button whose glyphs cross over', () => {
    expect(block('.chat-send svg')).toMatch(/grid-area/)
    expect(block(".chat-send[data-kind='stop'] svg[data-glyph='stop']")).toMatch(/opacity:\s*1/)
  })
  it('the slash menu grows from the slash at its corner', () => {
    expect(block('.chat-slash-menu')).toMatch(/transform-origin:\s*0% 100%/)
  })
  it('reduced motion keeps every fade and drops every move', () => {
    for (const selector of [...ARRIVALS, '.chat-drop-overlay'])
      expect(reduced, `${selector} under reduced motion`).toContain(selector)
    expect(reduced).toMatch(/transition-property:\s*opacity/)
    expect(reduced).toMatch(/@starting-style\s*\{[^}]*translate:\s*none/)
    expect(reduced).toMatch(/animation-name:\s*scrim-in/)
  })
})
