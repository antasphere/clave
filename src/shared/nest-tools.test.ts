import { describe, expect, it } from 'vitest'
import { attachAnswer, attachRequest } from './nest-tools'

/** `clave_attach_session`'s arguments and answer (PRDCT-4997), read the same
 *  way on every road. */
const TAB = '00000000-0000-4000-8000-000000000001'
const PARENT = '00000000-0000-4000-8000-000000000002'
const RULE = 'Pass exactly one of: to (the tab it goes under) or detach: true (take it out)'

describe('the argument rule', () => {
  it('nests the caller by default, under the tab named', () => {
    expect(attachRequest({ to: PARENT })).toEqual({ subject: 'mine', type: 'nest', to: PARENT })
    expect(attachRequest({ sessionId: TAB, to: 'mine' })).toEqual({
      subject: TAB,
      type: 'nest',
      to: 'mine'
    })
  })

  it('takes a tab out with detach: true', () => {
    expect(attachRequest({ sessionId: TAB, detach: true })).toEqual({
      subject: TAB,
      type: 'detach'
    })
  })

  it('refuses neither, both, an empty to, and a detach that is not true', () => {
    expect(() => attachRequest({})).toThrow(RULE)
    expect(() => attachRequest({ to: PARENT, detach: true })).toThrow(RULE)
    expect(() => attachRequest({ to: '  ' })).toThrow(RULE)
    expect(() => attachRequest({ detach: 'yes' })).toThrow(RULE)
    expect(() => attachRequest({ to: PARENT, detach: false })).not.toThrow()
  })
})

describe('the answer', () => {
  it('names the subject, where it is nested now, and whether the record changed', () => {
    expect(attachAnswer({ id: TAB, under: PARENT, changed: true })).toEqual({
      sessionId: TAB,
      nestedUnder: PARENT,
      changed: true
    })
    expect(attachAnswer({ id: TAB, under: null, changed: false })).toEqual({
      sessionId: TAB,
      nestedUnder: null,
      changed: false
    })
  })
})
