import type { ModelPrice, PRICE_FIELDS, PriceTable } from './prices'
import { parseGap } from './settings'

/**
 * The pure half of the settings page: the price table as the rows of inputs the page shows,
 * the rows back into a table the server takes, and the gap's patch. No DOM and no fetch here,
 * so every sentence the page can say about a refused value is tested.
 */

/**
 * The five prices in the order of `PRICE_FIELDS`. The list is restated here because `prices.ts`
 * reads files from disk and the page bundle runs in a browser; a test holds the two equal.
 */
export const PRICE_INPUTS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite5m',
  'cacheWrite1h'
] as const satisfies typeof PRICE_FIELDS

/** One model of the table as its inputs hold it: every value a string. */
export interface PriceRow {
  id: string
  name: string
  input: string
  output: string
  cacheRead: string
  cacheWrite5m: string
  cacheWrite1h: string
}

/** The column labels of the table, and the words a refusal names a field by. */
export const FIELD_LABELS: Record<keyof ModelPrice, string> = {
  name: 'Name',
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite5m: 'Cache write 5 min',
  cacheWrite1h: 'Cache write 1 h'
}

export type TableResult =
  | { table: PriceTable }
  | { error: string; row: number; field: keyof PriceRow }

/** The table's models as rows, in the table's order. */
export function rowsFromTable(table: PriceTable): PriceRow[] {
  return Object.entries(table.models).map(([id, p]) => ({
    id,
    name: p.name,
    input: String(p.input),
    output: String(p.output),
    cacheRead: String(p.cacheRead),
    cacheWrite5m: String(p.cacheWrite5m),
    cacheWrite1h: String(p.cacheWrite1h)
  }))
}

/** The local day of a date as `YYYY-MM-DD`. */
export function localDay(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** A price as its input gives it: a number of zero or more, else null. An empty input is not zero. */
function parsePrice(value: string): number | null {
  const text = value.trim()
  if (text === '') return null
  const n = Number(text)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * The rows as a table the server takes, or the first refusal with the row and the field it is
 * about. Every value is trimmed. A name left empty takes the id. The table is dated `now`, local
 * day, and its source says it was edited here.
 */
export function tableFromRows(rows: PriceRow[], now: Date): TableResult {
  const models: Record<string, ModelPrice> = {}
  for (const [row, r] of rows.entries()) {
    const id = r.id.trim()
    if (id === '') return { error: 'The model id is empty.', row, field: 'id' }
    if (Object.prototype.hasOwnProperty.call(models, id))
      return { error: `The model id ${id} is used twice.`, row, field: 'id' }
    const prices = {} as Record<(typeof PRICE_INPUTS)[number], number>
    for (const field of PRICE_INPUTS) {
      const n = parsePrice(r[field])
      if (n === null) {
        const label = FIELD_LABELS[field].toLowerCase()
        return { error: `The ${label} of ${id} is not a number of zero or more.`, row, field }
      }
      prices[field] = n
    }
    models[id] = { name: r.name.trim() || id, ...prices }
  }
  const day = localDay(now)
  return { table: { source: `Edited in Clave on ${day}`, date: day, models } }
}

/** The gap's patch from its input, or the sentence that refuses it. */
export function gapPatch(
  value: string,
  bounds: { min: number; max: number }
): { patch: { gapMinutes: number } } | { error: string } {
  const gap = parseGap(value)
  if (gap === null || gap < bounds.min || gap > bounds.max)
    return { error: `The gap is a whole number of minutes from ${bounds.min} to ${bounds.max}.` }
  return { patch: { gapMinutes: gap } }
}
