import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyTokens } from './ledger'
import { cost, loadPrices } from './prices'

const shipped = join(__dirname, '../../../apps/plugins/analytics', 'prices.json')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('cost', () => {
  it('prices the reference coordinator session at 90.04 USD', () => {
    const table = loadPrices(shipped, null)
    const { usd, unpriced } = cost(
      {
        'claude-fable-5-1': {
          ...emptyTokens(),
          input: 4020,
          cacheWrite1h: 2_521_426,
          cacheRead: 96_049_814,
          output: 311_188
        }
      },
      table
    )
    expect(usd.toFixed(2)).toBe('90.04')
    expect(unpriced).toEqual([])
  })

  it('prices an unsplit cache write as a 5-minute entry, and never rounds', () => {
    const table = loadPrices(shipped, null)
    const { usd } = cost(
      { 'claude-opus-5-5': { ...emptyTokens(), cacheWriteUnsplit: 1, cacheWrite5m: 1 } },
      table
    )
    expect(usd).toBeCloseTo(10 / 1e6, 12)
  })

  it('sends an unknown model to unpriced', () => {
    const table = loadPrices(shipped, null)
    const { usd, unpriced } = cost(
      { 'claude-mystery-1': { ...emptyTokens(), input: 100, output: 20 } },
      table
    )
    expect(usd).toBe(0)
    expect(unpriced).toEqual([{ model: 'claude-mystery-1', tokens: 120 }])
  })
})

describe('loadPrices', () => {
  it('lets the override win when it parses, and falls back when it does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'analytics-prices-'))
    dirs.push(dir)
    const override = join(dir, 'prices.json')
    writeFileSync(
      override,
      JSON.stringify({
        source: 'a person',
        date: '2026-12-01',
        models: {
          'claude-mystery-1': {
            name: 'Mystery',
            input: 1,
            output: 2,
            cacheRead: 0.1,
            cacheWrite5m: 1.25,
            cacheWrite1h: 2
          }
        }
      })
    )
    const table = loadPrices(shipped, override)
    expect(table.date).toBe('2026-12-01')
    expect(Object.keys(table.models)).toEqual(['claude-mystery-1'])

    writeFileSync(override, '{ not json')
    expect(loadPrices(shipped, override).date).toBe('2026-11-03')
    expect(loadPrices(shipped, join(dir, 'absent.json')).models['claude-fable-5-1']?.input).toBe(10)
  })
})
