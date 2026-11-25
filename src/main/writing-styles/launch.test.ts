import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { BUILT_IN_STYLES, composeStyleText } from '../../shared/writing-styles'
import { setWritingStylesSource } from './source'
import { appliedStyleFile, decideLaunchStyle, type StyleDecisionInput } from './launch'
import { installTerminalPorts, resetTerminalPorts } from '../ports/terminals'
import { fileStorage } from '../ports/storage'
import { tempDataDir } from '../ports/testing'

const mine = {
  id: 'dense',
  name: 'Dense',
  description: 'Short.',
  text: 'Be short.',
  statusCard: false,
  builtIn: false
}
const dense = { id: 'dense', text: 'Be short.' }
const quiet = { id: 'quiet', text: composeStyleText(BUILT_IN_STYLES[1]) }
const install = (defaultStyleId: string | null): void =>
  setWritingStylesSource({
    view: () => ({ styles: [...BUILT_IN_STYLES, mine], defaultStyleId, claudeOutputStyle: null })
  })
const launch = (over: Partial<StyleDecisionInput>): ReturnType<typeof decideLaunchStyle> =>
  decideLaunchStyle({ family: 'claude', chat: false, adopting: false, routine: false, ...over })

beforeEach(() => install('dense'))
afterEach(() => setWritingStylesSource(null))

describe('the style a first launch runs on (PRDCT-5166)', () => {
  it("is the machine's default when the launch names none", () => {
    expect(launch({})).toEqual({ ok: true, style: dense })
    expect(launch({ family: 'codex', chat: true })).toEqual({ ok: true, style: dense })
  })

  it('is the style the launch names, over the default', () => {
    expect(launch({ named: 'quiet' })).toEqual({ ok: true, style: quiet })
  })

  it('is none when the launch says none', () => {
    expect(launch({ named: 'none' })).toEqual({ ok: true, style: null })
  })

  it('refuses a style the machine does not have', () => {
    const answer = launch({ named: 'verbose' })
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.reason).toContain('Unknown writing style "verbose"')
  })

  it('is none on a machine with no default when the launch names none', () => {
    install(null)
    expect(launch({})).toEqual({ ok: true, style: null })
  })
})

describe('a spawn that runs no harness, or one that cannot take a style there', () => {
  it('is none for a plain terminal and for the agents view, even when one is named', () => {
    expect(launch({ family: null, named: 'quiet' })).toEqual({ ok: true, style: null })
    expect(launch({ agentsMode: true, named: 'quiet' })).toEqual({ ok: true, style: null })
  })

  it('is none for an Antigravity terminal that names none, and the style for its chat', () => {
    // The machine's default simply does not apply there, in silence.
    expect(launch({ family: 'antigravity', chat: false })).toEqual({ ok: true, style: null })
    expect(launch({ family: 'antigravity', chat: false, named: 'none' })).toEqual({
      ok: true,
      style: null
    })
    expect(launch({ family: 'antigravity', chat: true })).toEqual({ ok: true, style: dense })
  })

  it('refuses a style an Antigravity terminal names, with why and the way out', () => {
    expect(launch({ family: 'antigravity', chat: false, named: 'quiet' })).toEqual({
      ok: false,
      reason:
        'Antigravity takes no writing style in a terminal tab: open it as a chat, or name no style.'
    })
    // A style the machine does not have is refused as everywhere, with the list.
    const unknown = launch({ family: 'antigravity', chat: false, named: 'verbose' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok)
      expect(unknown.reason).toBe(
        'Unknown writing style "verbose". This machine has: none, brief, quiet, dense.'
      )
  })

  it('brings an Antigravity terminal back on none, never refused', () => {
    expect(launch({ family: 'antigravity', chat: false, adopting: true, named: 'quiet' })).toEqual({
      ok: true,
      style: null
    })
    expect(
      launch({ family: 'antigravity', chat: false, adopting: true, recorded: 'quiet' })
    ).toEqual({ ok: true, style: null })
  })
})

describe('a terminal tab on Windows', () => {
  const win = (over: Partial<StyleDecisionInput>): ReturnType<typeof decideLaunchStyle> =>
    launch({ windows: true, ...over })

  it("takes no style when it names none, the machine's default not applying", () => {
    expect(win({})).toEqual({ ok: true, style: null })
    expect(win({ named: 'none' })).toEqual({ ok: true, style: null })
    expect(win({ routine: true })).toEqual({ ok: true, style: null })
  })

  it('refuses a style it names, and one the machine does not have with the list', () => {
    expect(win({ named: 'quiet' })).toEqual({
      ok: false,
      reason:
        'A terminal tab takes no writing style on Windows: open it as a chat, or name no style.'
    })
    const unknown = win({ named: 'verbose' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toContain('Unknown writing style "verbose"')
  })

  it('comes back on none, never refused', () => {
    expect(win({ adopting: true, named: 'quiet' })).toEqual({ ok: true, style: null })
    expect(win({ adopting: true, recorded: 'quiet' })).toEqual({ ok: true, style: null })
  })

  it("leaves a chat on Windows to the machine's styles", () => {
    expect(win({ family: 'codex', chat: true })).toEqual({ ok: true, style: dense })
    expect(win({ family: 'codex', chat: true, named: 'quiet' })).toEqual({
      ok: true,
      style: quiet
    })
  })
})

describe("a routine's run", () => {
  it('runs on none when it names none: nobody reads an unattended run', () => {
    expect(launch({ routine: true })).toEqual({ ok: true, style: null })
  })

  it('runs on the style it names', () => {
    expect(launch({ routine: true, named: 'quiet' })).toEqual({ ok: true, style: quiet })
  })
})

describe('a tab launched again', () => {
  it("runs on its record's style, never the default", () => {
    expect(launch({ adopting: true, recorded: 'quiet' })).toEqual({ ok: true, style: quiet })
    expect(launch({ adopting: true })).toEqual({ ok: true, style: null })
  })

  it('takes the style the restart carries over the record it reads', () => {
    expect(launch({ adopting: true, named: 'quiet', recorded: 'dense' })).toEqual({
      ok: true,
      style: quiet
    })
  })

  it('comes back on none, never refused, when its style was deleted since', () => {
    expect(launch({ adopting: true, recorded: 'gone' })).toEqual({ ok: true, style: null })
    expect(launch({ adopting: true, named: 'gone' })).toEqual({ ok: true, style: null })
  })

  it('keeps its style on another harness, given it there', () => {
    expect(launch({ adopting: true, recorded: 'quiet', family: 'pi', chat: true })).toEqual({
      ok: true,
      style: quiet
    })
  })
})

describe('the file an OpenCode tab reads its style from', () => {
  let dir: string
  beforeEach(() => {
    dir = tempDataDir('clave-style-file-')
    installTerminalPorts({ storage: fileStorage(dir) })
  })
  afterEach(() => resetTerminalPorts())

  it('is written once under the data folder, named by the text, holding the text', () => {
    const file = appliedStyleFile('Be short.')
    expect(path.dirname(file)).toBe(path.join(dir, 'writing-styles', 'applied'))
    expect(path.basename(file)).toMatch(/^[0-9a-f]{16}\.md$/)
    expect(fs.readFileSync(file, 'utf8')).toBe('Be short.')
    // A second tab on the same text reads the same file, not rewritten.
    fs.utimesSync(file, new Date(0), new Date(0))
    expect(appliedStyleFile('Be short.')).toBe(file)
    expect(fs.statSync(file).mtimeMs).toBe(0)
  })

  it('is another file for another text', () => {
    expect(appliedStyleFile('Be short.')).not.toBe(appliedStyleFile('Be long.'))
  })
})
