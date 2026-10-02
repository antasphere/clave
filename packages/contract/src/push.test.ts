import { describe, expect, it } from 'vitest'
import { Either } from 'effect'
import {
  decodeClientFrame,
  decodeServerFrame,
  encodeClientFrame,
  encodeServerFrame,
  type ServerFrame
} from './push'

describe('push frames', () => {
  it('round-trips every client frame as one JSON text', () => {
    for (const frame of [
      { _tag: 'hello', token: 't', client: 'test' },
      { _tag: 'subscribe', sessionId: 's' },
      { _tag: 'unsubscribe', sessionId: 's' },
      { _tag: 'ping' }
    ] as const) {
      const text = encodeClientFrame(frame)
      expect(typeof text).toBe('string')
      expect(decodeClientFrame(text)).toEqual(Either.right(frame))
    }
  })
  it('round-trips a stream frame with terminal bytes', () => {
    const frame: ServerFrame = {
      _tag: 'stream',
      sessionId: 's',
      stream: { kind: 'pty', data: new Uint8Array([104, 105]) }
    }
    const text = encodeServerFrame(frame)
    expect(JSON.parse(text)).toEqual({
      _tag: 'stream',
      sessionId: 's',
      stream: { kind: 'pty', data: 'aGk=' }
    })
    const back = decodeServerFrame(text)
    expect(Either.isRight(back)).toBe(true)
    if (Either.isRight(back) && back.right._tag === 'stream' && back.right.stream.kind === 'pty')
      expect(Array.from(back.right.stream.data)).toEqual([104, 105])
  })
  it('refuses what is not a frame', () => {
    expect(Either.isLeft(decodeClientFrame('not json'))).toBe(true)
    expect(Either.isLeft(decodeClientFrame('{"_tag":"hello"}'))).toBe(true)
    expect(Either.isLeft(decodeClientFrame('{"_tag":"shutdown"}'))).toBe(true)
    expect(Either.isLeft(decodeServerFrame('{"_tag":"welcome","serverId":"x","protocol":2}'))).toBe(
      true
    )
  })
})
