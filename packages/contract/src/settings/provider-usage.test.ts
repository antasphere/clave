import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import { ReadProviderUsage } from './index'
import {
  PROVIDER_USAGE_KINDS,
  usageLineText,
  type ProviderUsageLineView
} from './provider-usage-view'

// A connection's usage line on the wire (PRDCT-4496): the answer the server
// sends is the line the window reads, and the query's payload is read off the URL.

const LINES: ProviderUsageLineView[] = [
  { kind: 'balance', left: '12.50', currency: 'USD' },
  { kind: 'limit', left: '3.00', of: '10.00', currency: 'USD' },
  { kind: 'used', used: '7.25', currency: 'USD' },
  { kind: 'payPerUse' },
  { kind: 'plan' },
  { kind: 'local' },
  { kind: 'unknown', reason: 'The provider could not be reached.' }
]

describe('ReadProviderUsage', () => {
  const success = ReadProviderUsage.success as unknown as Schema.Schema<unknown, unknown>

  it('carries a line of each of the seven kinds through the wire unchanged', () => {
    expect(LINES.map((l) => l.kind)).toEqual([...PROVIDER_USAGE_KINDS])
    for (const line of LINES) {
      const encoded = Schema.encodeUnknownSync(success)(line)
      expect(Schema.decodeUnknownSync(success)(JSON.parse(JSON.stringify(encoded)))).toEqual(line)
    }
  })

  it('refuses a kind outside the seven, and a kind without its fields', () => {
    const bad = { kind: 'credits', left: '1.00', currency: 'USD' }
    expect(Either.isLeft(Schema.decodeUnknownEither(success)(bad))).toBe(true)
    expect(Either.isLeft(Schema.encodeUnknownEither(success)(bad))).toBe(true)
    expect(Either.isLeft(Schema.decodeUnknownEither(success)({ kind: 'balance' }))).toBe(true)
  })

  it('reads the id and the flag as a string, the flag optional', () => {
    const payload = ReadProviderUsage.payload as unknown as Schema.Schema<unknown, unknown>
    expect(Schema.decodeUnknownSync(payload)({ connectionId: 'c1', force: 'true' })).toEqual({
      connectionId: 'c1',
      force: true
    })
    expect(Schema.decodeUnknownSync(payload)({ connectionId: 'c1' })).toEqual({
      connectionId: 'c1'
    })
    expect(Either.isLeft(Schema.decodeUnknownEither(payload)({}))).toBe(true)
  })
})

describe('usageLineText', () => {
  it('says each kind in the person’s words', () => {
    expect(LINES.map(usageLineText)).toEqual([
      '12.50 USD left',
      '3.00 of 10.00 USD left',
      'Pay per use · 7.25 USD used',
      'Pay per use',
      'Coding plan',
      'Local',
      'Usage unknown'
    ])
  })
})
