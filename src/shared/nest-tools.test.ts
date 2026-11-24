import { describe, expect, it } from 'vitest'
import {
  attachAnswer,
  attachRequest,
  nestAnswerError,
  nestRefusalIn,
  nestRefusalMessage,
  NEST_TAB_GONE
} from './nest-tools'

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

describe('a refusal across the bridge', () => {
  const tagged = (tag: string, message: string, more: object = {}): Error =>
    Object.assign(new Error(message), { _tag: tag, ...more })

  it('is the server’s sentence, marked, and read back as it was', () => {
    const sentence = 'This tab works on the lane "http://10.0.0.1/tmp/ENOENT", whose entry shows it'
    expect(nestRefusalIn(nestRefusalMessage(sentence))).toBe(sentence)
    expect(nestRefusalIn(sentence)).toBeNull()
    expect(nestRefusalIn('')).toBeNull()
  })

  it('marks the three answers that are a no', () => {
    const read = (error: unknown): string | null =>
      nestRefusalIn((nestAnswerError(error) as Error).message)
    expect(read(tagged('NestRefused', 'A tab cannot be nested under itself'))).toBe(
      'A tab cannot be nested under itself'
    )
    expect(read(tagged('SessionNotFound', '{ "id": "x" }', { id: 'x' }))).toBe(NEST_TAB_GONE)
    expect(read(tagged('CapabilityUnavailable', 'This server has no terminals'))).toBe(
      'This server has no terminals'
    )
  })

  it('leaves a call that was never answered as it came', () => {
    const silent = new Error('socket hang up')
    expect(nestAnswerError(silent)).toBe(silent)
    const unreachable = tagged('ServerUnreachable', 'connect ECONNREFUSED 127.0.0.1:43127')
    expect(nestAnswerError(unreachable)).toBe(unreachable)
    expect(nestAnswerError('a string')).toBe('a string')
    expect(nestAnswerError(null)).toBeNull()
  })
})
