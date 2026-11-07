import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { asciiBytes, base64urlDecode, base64urlEncode, utf8Decode } from './encoding'

describe('base64url', () => {
  it('encodes as Node does, without padding, for every length', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = new Uint8Array(randomBytes(length))
      expect(base64urlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
      expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes)
    }
  })

  it('refuses padding, the standard alphabet and an impossible length', () => {
    expect(() => base64urlDecode('YQ==')).toThrow()
    expect(() => base64urlDecode('a+b/')).toThrow()
    expect(() => base64urlDecode('abcde')).toThrow()
  })
})

describe('utf8Decode', () => {
  const sample = 'Ada Éxample · 日本語 · 🚀'

  it('decodes with the runtime decoder', () => {
    expect(utf8Decode(new TextEncoder().encode(sample))).toBe(sample)
  })

  it('decodes the same without a TextDecoder in the runtime', () => {
    const g = globalThis as { TextDecoder?: unknown }
    const saved = g.TextDecoder
    delete g.TextDecoder
    try {
      expect(utf8Decode(new TextEncoder().encode(sample))).toBe(sample)
      expect(() => utf8Decode(new Uint8Array([0xe6, 0x97]))).toThrow()
      expect(() => utf8Decode(new Uint8Array([0xff]))).toThrow()
    } finally {
      g.TextDecoder = saved
    }
  })
})

describe('asciiBytes', () => {
  it('takes ASCII and refuses the rest', () => {
    expect(asciiBytes('abc-_')).toEqual(new Uint8Array([97, 98, 99, 45, 95]))
    expect(() => asciiBytes('é')).toThrow()
  })
})
