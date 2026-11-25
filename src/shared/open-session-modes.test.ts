import { describe, expect, it } from 'vitest'
import { STYLE_ARGUMENT_DESCRIPTION, listedStyle, openStyleField } from './open-session-modes'

/** The `style` of an open and of a listed tab, one rule for every road (PRDCT-5166). */
describe('the writing style of an open and of a listed tab', () => {
  it('passes the style an agent names untouched, the spawn resolving it', () => {
    expect(openStyleField('claude', 'Quiet')).toEqual({ writingStyle: 'Quiet' })
    expect(openStyleField('antigravity', 'none')).toEqual({ writingStyle: 'none' })
    expect(openStyleField('claude', undefined)).toEqual({})
  })

  it('refuses a style on a terminal, in the words of the other agent-only arguments', () => {
    expect(() => openStyleField('terminal', 'brief')).toThrow(
      'The style argument applies to agent modes only (got mode "terminal")'
    )
    expect(openStyleField('terminal', undefined)).toEqual({})
  })

  it('lists the style a record keeps, and no key for none', () => {
    expect(listedStyle('quiet')).toEqual({ style: 'quiet' })
    expect(listedStyle(undefined)).toEqual({})
    expect(listedStyle(null)).toEqual({})
    expect(listedStyle('none')).toEqual({})
  })

  it('says how to choose a style, where to list them and that a tab keeps its own', () => {
    expect(STYLE_ARGUMENT_DESCRIPTION).toContain('clave_launch_options lists the styles')
    expect(STYLE_ARGUMENT_DESCRIPTION).toContain('A tab keeps the style it was opened with.')
  })
})
