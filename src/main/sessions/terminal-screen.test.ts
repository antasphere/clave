import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  forgetScreen,
  hasScreen,
  noteSize,
  renderScreen,
  resetScreensForTests,
  retainOutput
} from './terminal-screen'

afterEach(() => resetScreensForTests())

describe('the retained screen', () => {
  it('renders what the terminal printed as lines, trailing blank rows dropped', async () => {
    retainOutput('t', '$ ls\r\n')
    retainOutput('t', 'a  b\r\n\r\n\r\n')
    const screen = await renderScreen('t', 100)
    expect(screen).toEqual({ lines: ['$ ls', 'a  b'], cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
  })
  it('renders through the escape sequences a TUI writes, at the size the pane gave', async () => {
    noteSize('t', 20, 5)
    // Colour, then a cursor move up one line that overwrites a cell of the
    // line above (column kept), as a TUI's repaint does.
    retainOutput('t', '\x1b[31mred\x1b[0m line\r\nsecond\r\nthird\x1b[1A!\r\n')
    const screen = await renderScreen('t', 100)
    expect(screen.cols).toBe(20)
    expect(screen.rows).toBe(5)
    expect(screen.lines).toEqual(['red line', 'secon!', 'third'])
  })
  it('answers the last N lines only', async () => {
    retainOutput('t', Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\r\n'))
    const screen = await renderScreen('t', 3)
    expect(screen.lines).toEqual(['line 28', 'line 29', 'line 30'])
    // The empty row the cursor sits on is padding, not a line.
    retainOutput('t', '\r\n')
    expect((await renderScreen('t', 3)).lines).toEqual(['line 28', 'line 29', 'line 30'])
  })
  it('evicts whole early chunks once the ring is over its size', async () => {
    retainOutput('t', 'aaaa', 8)
    retainOutput('t', 'bbbb', 8)
    retainOutput('t', 'cc', 8)
    const screen = await renderScreen('t', 5)
    expect(screen.lines).toEqual(['bbbbcc'])
  })
  it('keeps the recent output only, by the ring size', async () => {
    retainOutput('t', 'old '.repeat(10), 32)
    retainOutput('t', 'new', 32)
    const screen = await renderScreen('t', 5)
    expect(screen.lines.join('')).not.toContain('old old old old old old old old old old')
    expect(screen.lines.join('')).toContain('new')
  })
  it('knows nothing of a session that printed nothing, or that is gone', async () => {
    expect(hasScreen('none')).toBe(false)
    await expect(renderScreen('none', 10)).rejects.toThrow('no terminal buffer')
    retainOutput('t', 'x')
    expect(hasScreen('t')).toBe(true)
    forgetScreen('t')
    expect(hasScreen('t')).toBe(false)
  })
})
