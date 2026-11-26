import { afterEach, describe, expect, it } from 'vitest'
import { BUILT_IN_STYLES, composeStyleText } from '../../shared/writing-styles'
import { launchStyle, recordedStyle, setWritingStylesSource, writingStylesView } from './source'

const mine = {
  id: 'dense',
  name: 'Dense',
  description: 'Short.',
  text: 'Be short.',
  statusCard: false,
  builtIn: false
}
const install = (defaultStyleId: string | null): void =>
  setWritingStylesSource({
    view: () => ({ styles: [...BUILT_IN_STYLES, mine], defaultStyleId, claudeOutputStyle: null })
  })

afterEach(() => setWritingStylesSource(null))

describe('writingStylesView', () => {
  it('is the built-in styles and no default on a process with no store', () => {
    expect(writingStylesView()).toEqual({
      styles: [...BUILT_IN_STYLES],
      defaultStyleId: null,
      claudeOutputStyle: null
    })
  })
})

describe('launchStyle', () => {
  it('is no style for a launch that names none on a machine with no default', () => {
    install(null)
    expect(launchStyle(undefined)).toEqual({ ok: true, style: null })
  })

  it("is the machine's default for a launch that names none", () => {
    install('dense')
    expect(launchStyle(undefined)).toEqual({ ok: true, style: { id: 'dense', text: 'Be short.' } })
  })

  it('is the style the launch names, by id or by name, over the default', () => {
    install('dense')
    expect(launchStyle('quiet')).toEqual({
      ok: true,
      style: { id: 'quiet', text: composeStyleText(BUILT_IN_STYLES[1]) }
    })
    expect(launchStyle('Dense')).toEqual({ ok: true, style: { id: 'dense', text: 'Be short.' } })
  })

  it('is no style for a launch that says none, whatever the default', () => {
    install('dense')
    expect(launchStyle('none')).toEqual({ ok: true, style: null })
  })

  it('refuses a style the machine does not have, naming the ones it has', () => {
    install(null)
    const answer = launchStyle('verbose')
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.reason).toContain('none, brief, quiet, dense')
  })

  it('is no style when the default names a style deleted since', () => {
    install('gone')
    expect(launchStyle(undefined)).toEqual({ ok: true, style: null })
  })
})

describe('recordedStyle', () => {
  it("is the record's style while the machine has it, and never the default", () => {
    install('dense')
    expect(recordedStyle('quiet')?.id).toBe('quiet')
    expect(recordedStyle('none')).toBeNull()
    expect(recordedStyle(undefined)).toBeNull()
  })

  it('is no style for a style deleted since, never a refusal', () => {
    install('dense')
    expect(recordedStyle('gone')).toBeNull()
  })
})
