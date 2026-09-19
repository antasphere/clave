import { describe, expect, it } from 'vitest'
import { JsonLines } from './transport'
import { ServerEvents } from './opencode'

describe('bounded provider framing', () => {
  it('preserves split UTF-8 and multiple frames', () => {
    const frames: unknown[] = []
    const parser = new JsonLines((value) => frames.push(value))
    const bytes = Buffer.from('{"text":"é"}\r\n{"type":"done"}\n')
    for (const byte of bytes) parser.push(Buffer.from([byte]))
    parser.end()
    expect(frames).toEqual([{ text: 'é' }, { type: 'done' }])
  })
  it('rejects invalid JSON, non-object frames, truncated and oversized lines', () => {
    for (const input of ['oops\n', '[]\n', 'null\n']) {
      expect(() => new JsonLines(() => {}).push(Buffer.from(input))).toThrow()
    }
    const parser = new JsonLines(() => {})
    parser.push(Buffer.from('{"unfinished":'))
    expect(() => parser.end()).toThrow()
    expect(() => new JsonLines(() => {}, 8).push(Buffer.from('123456789'))).toThrow()
  })
})

describe('SSE framing', () => {
  it('preserves split UTF-8 and ignores keepalives', () => {
    const frames: unknown[] = []
    const parser = new ServerEvents((frame) => frames.push(frame))
    for (const byte of Buffer.from(': heartbeat\r\n\r\ndata: {"text":"é"}\r\n\r\n'))
      parser.push(Buffer.from([byte]))
    expect(frames).toEqual([{ text: 'é' }])
  })
  it('rejects malformed event JSON', () => {
    expect(() => new ServerEvents(() => {}).push(Buffer.from('data: invalid\n\n'))).toThrow()
  })
})
