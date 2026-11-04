import { readFileSync } from 'node:fs'
import type { Tokens } from './ledger'

/** List prices in USD per million tokens, per model id. */
export interface ModelPrice {
  name: string
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export interface PriceTable {
  source: string
  date: string
  models: Record<string, ModelPrice>
}

export interface Cost {
  usd: number
  unpriced: { model: string; tokens: number }[]
}

export const EMPTY_PRICES: PriceTable = { source: 'none', date: 'unknown', models: {} }

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseTable(text: string): PriceTable | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const models = obj['models']
  if (!models || typeof models !== 'object' || Array.isArray(models)) return null
  const table: PriceTable = {
    source: typeof obj['source'] === 'string' ? obj['source'] : '',
    date: typeof obj['date'] === 'string' ? obj['date'] : 'unknown',
    models: {}
  }
  for (const [id, value] of Object.entries(models as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const p = value as Record<string, unknown>
    const fields = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const
    if (!fields.every((f) => isNum(p[f]))) continue
    table.models[id] = {
      name: typeof p['name'] === 'string' ? p['name'] : id,
      input: p['input'] as number,
      output: p['output'] as number,
      cacheRead: p['cacheRead'] as number,
      cacheWrite5m: p['cacheWrite5m'] as number,
      cacheWrite1h: p['cacheWrite1h'] as number
    }
  }
  return table
}

function readTable(path: string | null): PriceTable | null {
  if (!path) return null
  try {
    return parseTable(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The shipped table, unless the override (a copy in the data folder) parses. */
export function loadPrices(shippedPath: string, overridePath: string | null): PriceTable {
  return readTable(overridePath) ?? readTable(shippedPath) ?? EMPTY_PRICES
}

/** Tokens of one model, read and written. */
function allTokens(t: Tokens): number {
  return t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheWriteUnsplit + t.cacheRead + t.output
}

/**
 * The list-price value of a per-model tally. An unsplit cache write (an older row that
 * carries no 5m/1h split) is priced as a 5-minute entry. Never rounded here: the sum
 * of many sessions is only rounded when it is displayed.
 */
export function cost(byModel: Record<string, Tokens>, table: PriceTable): Cost {
  let usd = 0
  const unpriced: Cost['unpriced'] = []
  for (const [model, t] of Object.entries(byModel)) {
    const p = table.models[model]
    if (!p) {
      const tokens = allTokens(t)
      if (tokens > 0) unpriced.push({ model, tokens })
      continue
    }
    usd +=
      (t.input * p.input +
        t.cacheWrite5m * p.cacheWrite5m +
        t.cacheWrite1h * p.cacheWrite1h +
        t.cacheWriteUnsplit * p.cacheWrite5m +
        t.cacheRead * p.cacheRead +
        t.output * p.output) /
      1e6
  }
  return { usd, unpriced }
}
