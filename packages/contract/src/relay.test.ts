import { describe, expect, it } from 'vitest'
import { Either } from 'effect'
import {
  RELAY_PROTOCOL,
  decodeMachineCredential,
  decodeMachineFrame,
  decodeMachineRecord,
  decodeRelayFrame,
  encodeMachineFrame,
  encodeRelayFrame,
  parseMachinePath
} from './relay'

describe('the road path', () => {
  it('splits the machine id from the path it carries, the query kept', () => {
    expect(parseMachinePath('/m/m_0123abcd/sessions?windowKey=w1')).toEqual({
      machineId: 'm_0123abcd',
      path: '/sessions?windowKey=w1'
    })
    expect(parseMachinePath('/m/m_0123abcd/push')).toEqual({
      machineId: 'm_0123abcd',
      path: '/push'
    })
    expect(parseMachinePath('/m/m_0123abcd')).toEqual({ machineId: 'm_0123abcd', path: '/' })
    expect(parseMachinePath('/m/m_0123abcd?x=1')).toEqual({
      machineId: 'm_0123abcd',
      path: '/?x=1'
    })
  })
  it('is not a road without an id made of the characters an id has', () => {
    expect(parseMachinePath('/machines')).toBeNull()
    expect(parseMachinePath('/m/')).toBeNull()
    expect(parseMachinePath('/m//sessions')).toBeNull()
    expect(parseMachinePath('/m/../etc')).toBeNull()
    expect(parseMachinePath('/m/a b/sessions')).toBeNull()
    expect(parseMachinePath(`/m/${'x'.repeat(65)}/sessions`)).toBeNull()
    expect(parseMachinePath('/health')).toBeNull()
  })
})

describe('the frames', () => {
  it('round-trip, discriminated by their tag, bodies as base64 text', () => {
    const request = encodeRelayFrame({
      _tag: 'request',
      id: 'r1',
      method: 'POST',
      path: '/sessions/write',
      headers: { authorization: 'Bearer x', 'set-cookie': ['a=1', 'b=2'] },
      body: Buffer.from('{"id":"s1"}').toString('base64')
    })
    const decoded = decodeRelayFrame(request)
    expect(Either.isRight(decoded)).toBe(true)
    if (Either.isRight(decoded) && decoded.right._tag === 'request') {
      expect(decoded.right.headers['set-cookie']).toEqual(['a=1', 'b=2'])
      expect(Buffer.from(decoded.right.body, 'base64').toString()).toBe('{"id":"s1"}')
    }
    const response = encodeMachineFrame({
      _tag: 'response',
      id: 'r1',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: ''
    })
    expect(Either.isRight(decodeMachineFrame(response))).toBe(true)
    const welcome = decodeRelayFrame(
      JSON.stringify({ _tag: 'welcome', machineId: 'm_1', protocol: RELAY_PROTOCOL })
    )
    expect(Either.isRight(welcome)).toBe(true)
  })
  it('refuses a frame of another protocol, an unknown tag, or a missing field', () => {
    expect(
      Either.isLeft(
        decodeRelayFrame(JSON.stringify({ _tag: 'welcome', machineId: 'm_1', protocol: 2 }))
      )
    ).toBe(true)
    expect(Either.isLeft(decodeMachineFrame(JSON.stringify({ _tag: 'shout', text: 'hi' })))).toBe(
      true
    )
    expect(
      Either.isLeft(decodeMachineFrame(JSON.stringify({ _tag: 'hello', machineId: 'm_1' })))
    ).toBe(true)
    expect(Either.isLeft(decodeMachineFrame('not json'))).toBe(true)
  })
  it('accepts a record and a credential as the relay answers them, and nothing looser', () => {
    expect(
      Either.isRight(
        decodeMachineRecord({ name: 'Mac', platform: 'macos', version: '1.0.0', direct: [] })
      )
    ).toBe(true)
    expect(
      Either.isLeft(
        decodeMachineRecord({ name: 'Box', platform: 'windows', version: '1.0.0', direct: [] })
      )
    ).toBe(true)
    expect(Either.isLeft(decodeMachineRecord({ name: 'Mac', platform: 'macos' }))).toBe(true)
    expect(
      Either.isRight(decodeMachineCredential({ machineId: 'm_1', machineSecret: 'cms_x' }))
    ).toBe(true)
    expect(Either.isLeft(decodeMachineCredential({ machineId: 'm_1' }))).toBe(true)
  })
})
