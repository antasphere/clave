import { describe, expect, it } from 'vitest'
import {
  LOCAL_SERVER_ID,
  parseResourceKey,
  parseSessionKey,
  resourceKey,
  sessionKey,
  type ResourceKind
} from './fleet'

describe('fleet owner keys', () => {
  it('keeps ordinary local IDs while separating colliding remote IDs and kinds', () => {
    expect(sessionKey({ serverId: LOCAL_SERVER_ID, sessionId: 'same' })).toBe('same')
    const keys = ['a', 'b', LOCAL_SERVER_ID].map((serverId) =>
      sessionKey({ serverId, sessionId: 'same' })
    )
    expect(new Set(keys).size).toBe(3)
    expect(parseSessionKey(keys[0])).toEqual({ serverId: 'a', sessionId: 'same' })
    expect(resourceKey('group', 'a', 'same')).not.toBe(keys[0])
  })
  it('round trips delimiters, unicode, paths, and local IDs resembling remote keys', () => {
    for (const kind of ['session', 'group', 'workspace', 'file', 'request'] as ResourceKind[]) {
      for (const serverId of ['a:/%?', 'host 🪐', LOCAL_SERVER_ID]) {
        for (const id of ['x:/%?#', '/a/b 🪐', 'clave-owner:session:a:same']) {
          const key = resourceKey(kind, serverId, id)
          expect(parseResourceKey(kind, key)).toEqual({ serverId, id })
          if (serverId !== LOCAL_SERVER_ID)
            expect(key).not.toBe(resourceKey(kind, LOCAL_SERVER_ID, key))
        }
      }
    }
  })
  it('rejects malformed and wrong-kind reserved keys rather than routing locally', () => {
    for (const key of [
      'clave-owner:',
      'clave-owner:session:a:%zz',
      'clave-owner:session::x',
      'clave-owner:group:a:x'
    ])
      expect(() => parseSessionKey(key)).toThrow()
  })
})
