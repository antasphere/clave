import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { SessionStream } from './sessions'
import { SessionPosition, TimelinePage, GetSessionTimeline } from './timeline'
import { SessionStreamSchema } from '../../../src/shared/session-model'

const position = { generation: 'process-adoption', sequence: 7 }
const event = { type: 'assistant_text', delta: 'same', final: true } as const

describe('ordered conversation contract', () => {
  it('keeps position through wire and zod decoding, and still accepts legacy streams', () => {
    for (const stream of [
      { kind: 'event', event, position },
      { kind: 'event', event }
    ]) {
      const encoded = Schema.encodeUnknownSync(SessionStream)(stream)
      expect(Schema.decodeUnknownSync(SessionStream)(encoded)).toEqual(stream)
      expect(SessionStreamSchema.parse(stream)).toEqual(stream)
    }
  })
  it('refuses invalid positions in both mirrors', () => {
    const invalid = [
      { ...position, generation: '' },
      { ...position, generation: null },
      ...[-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map((sequence) => ({
        ...position,
        sequence
      }))
    ]
    for (const value of invalid) {
      expect(Schema.is(SessionPosition)(value)).toBe(false)
      expect(SessionStreamSchema.safeParse({ kind: 'event', event, position: value }).success).toBe(
        false
      )
    }
    expect(Schema.is(SessionPosition)({ ...position, sequence: 0 })).toBe(true)
    expect(Schema.is(SessionPosition)({ ...position, sequence: Number.MAX_SAFE_INTEGER })).toBe(
      true
    )
  })
  it('requires positioned history, watermark and explicit retention state', () => {
    const page = { items: [{ event, position }], before: null, cursor: position, truncated: false }
    expect(Schema.decodeUnknownSync(TimelinePage)(page)).toEqual(page)
    expect(Schema.is(TimelinePage)({ ...page, truncated: undefined })).toBe(false)
    expect(Schema.is(TimelinePage)({ ...page, items: [{ event }] })).toBe(false)
    expect(
      Schema.decodeUnknownSync(GetSessionTimeline.payload)({ id: 's', before: '7', limit: '200' })
    ).toEqual({ id: 's', before: 7, limit: 200 })
    for (const limit of ['0', '2001', 'NaN', '-1'])
      expect(() =>
        Schema.decodeUnknownSync(GetSessionTimeline.payload)({ id: 's', limit })
      ).toThrow()
  })
})
