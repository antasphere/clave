import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import { decodeServerFrame, encodeServerFrame, type ServerFrame } from './push'
import { AnswerViewRequest, RequestView } from './views'

const decodeRequest = Schema.decodeUnknownEither(RequestView.payload)
const decodeAnswer = Schema.decodeUnknownEither(AnswerViewRequest.payload)

describe('the view request frame', () => {
  it('round-trips with a nested object payload', () => {
    const frame: ServerFrame = {
      _tag: 'request',
      requestId: 'r1',
      windowKey: 'w1',
      command: 'list',
      payload: { workspace: 'all', filter: { kinds: ['claude', 'codex'], depth: 2 } }
    }
    expect(decodeServerFrame(encodeServerFrame(frame))).toEqual(Either.right(frame))
  })
  it('round-trips with a null payload', () => {
    const frame: ServerFrame = {
      _tag: 'request',
      requestId: 'r2',
      windowKey: 'w1',
      command: 'focus',
      payload: null
    }
    expect(decodeServerFrame(encodeServerFrame(frame))).toEqual(Either.right(frame))
  })
})

describe('RequestView', () => {
  const base = { windowKey: 'w1', command: 'list', payload: {} }
  it('takes a deadline inside the bounds', () => {
    expect(Either.isRight(decodeRequest({ ...base, timeoutMs: 1 }))).toBe(true)
    expect(Either.isRight(decodeRequest({ ...base, timeoutMs: 60_000 }))).toBe(true)
  })
  it('refuses a deadline of 0 and one over the maximum', () => {
    expect(Either.isLeft(decodeRequest({ ...base, timeoutMs: 0 }))).toBe(true)
    expect(Either.isLeft(decodeRequest({ ...base, timeoutMs: 60_001 }))).toBe(true)
  })
  it('refuses a window key with a slash', () => {
    expect(Either.isLeft(decodeRequest({ ...base, windowKey: 'w1/../w2' }))).toBe(true)
  })
})

describe('AnswerViewRequest', () => {
  it('accepts an answer with neither a result nor an error', () => {
    expect(decodeAnswer({ requestId: 'r1', ok: true })).toEqual(
      Either.right({ requestId: 'r1', ok: true })
    )
  })
})
