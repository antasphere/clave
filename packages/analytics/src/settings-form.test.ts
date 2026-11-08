import { describe, expect, it } from 'vitest'
import { PRICE_FIELDS, type PriceTable } from './prices'
import {
  FIELD_LABELS,
  gapPatch,
  PRICE_INPUTS,
  rowsFromTable,
  tableFromRows,
  type PriceRow
} from './settings-form'

const table: PriceTable = {
  source: 'Anthropic list prices',
  date: '2026-10-01',
  models: {
    'claude-b': {
      name: 'Model B',
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite5m: 3.75,
      cacheWrite1h: 6
    },
    'claude-a': {
      name: 'Model A',
      input: 0,
      output: 25,
      cacheRead: 0.5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10
    }
  }
}

// A local noon, so the local day is the same in every time zone the tests run in.
const now = new Date(2026, 10, 4, 12, 0, 0)

function row(overrides: Partial<PriceRow> = {}): PriceRow {
  return {
    id: 'claude-x',
    name: 'Model X',
    input: '1',
    output: '2',
    cacheRead: '0.1',
    cacheWrite5m: '1.25',
    cacheWrite1h: '2',
    ...overrides
  }
}

describe('rowsFromTable and tableFromRows', () => {
  it('round-trips a table through its rows, the order kept', () => {
    const rows = rowsFromTable(table)
    expect(rows.map((r) => r.id)).toEqual(['claude-b', 'claude-a'])
    expect(rows[0]).toEqual({
      id: 'claude-b',
      name: 'Model B',
      input: '3',
      output: '15',
      cacheRead: '0.3',
      cacheWrite5m: '3.75',
      cacheWrite1h: '6'
    })
    const back = tableFromRows(rows, now)
    expect('table' in back).toBe(true)
    if (!('table' in back)) return
    expect(back.table.models).toEqual(table.models)
    expect(Object.keys(back.table.models)).toEqual(['claude-b', 'claude-a'])
  })

  it('dates the table from now and says it was edited in Clave', () => {
    const back = tableFromRows([row()], now)
    if (!('table' in back)) throw new Error(back.error)
    expect(back.table.date).toBe('2026-11-04')
    expect(back.table.source).toBe('Edited in Clave on 2026-11-04')
    const january = tableFromRows([row()], new Date(2027, 0, 9, 12))
    if (!('table' in january)) throw new Error(january.error)
    expect(january.table.date).toBe('2027-01-09')
  })

  it('trims, and an empty name takes the id', () => {
    const back = tableFromRows([row({ id: '  claude-y ', name: '   ', input: ' 4 ' })], now)
    if (!('table' in back)) throw new Error(back.error)
    expect(Object.keys(back.table.models)).toEqual(['claude-y'])
    expect(back.table.models['claude-y']!.name).toBe('claude-y')
    expect(back.table.models['claude-y']!.input).toBe(4)
  })

  it('refuses an empty id, naming its row and the id field', () => {
    expect(tableFromRows([row(), row({ id: 'claude-z' }), row({ id: '  ' })], now)).toEqual({
      error: 'The model id is empty.',
      row: 2,
      field: 'id'
    })
  })

  it('refuses a duplicate id on its second row', () => {
    expect(tableFromRows([row(), row({ id: 'claude-z' }), row({ id: ' claude-x' })], now)).toEqual({
      error: 'The model id claude-x is used twice.',
      row: 2,
      field: 'id'
    })
  })

  it('refuses a negative price, naming its row and its field', () => {
    expect(tableFromRows([row(), row({ id: 'claude-z', cacheWrite5m: '-1' })], now)).toEqual({
      error: 'The cache write 5 min of claude-z is not a number of zero or more.',
      row: 1,
      field: 'cacheWrite5m'
    })
  })

  it('refuses a price that is not a number, an empty one included', () => {
    expect(tableFromRows([row({ output: 'abc' })], now)).toEqual({
      error: 'The output of claude-x is not a number of zero or more.',
      row: 0,
      field: 'output'
    })
    expect(tableFromRows([row(), row({ id: 'claude-z', cacheWrite1h: '' })], now)).toEqual({
      error: 'The cache write 1 h of claude-z is not a number of zero or more.',
      row: 1,
      field: 'cacheWrite1h'
    })
  })

  it('lists the five prices in the order of PRICE_FIELDS', () => {
    expect([...PRICE_INPUTS]).toEqual([...PRICE_FIELDS])
  })

  it('labels every field of a model price', () => {
    expect(FIELD_LABELS).toEqual({
      name: 'Name',
      input: 'Input',
      output: 'Output',
      cacheRead: 'Cache read',
      cacheWrite5m: 'Cache write 5 min',
      cacheWrite1h: 'Cache write 1 h'
    })
  })
})

describe('gapPatch', () => {
  const bounds = { min: 1, max: 1440 }
  const refusal = { error: 'The gap is a whole number of minutes from 1 to 1440.' }

  it('accepts a whole number in bounds', () => {
    expect(gapPatch('20', bounds)).toEqual({ patch: { gapMinutes: 20 } })
    expect(gapPatch('1440', bounds)).toEqual({ patch: { gapMinutes: 1440 } })
  })

  it('refuses zero, over the maximum, a fraction and an empty input', () => {
    for (const value of ['0', '1441', '12.5', ''])
      expect(gapPatch(value, bounds), value).toEqual(refusal)
  })

  it('names the bounds it was given', () => {
    expect(gapPatch('90', { min: 5, max: 60 })).toEqual({
      error: 'The gap is a whole number of minutes from 5 to 60.'
    })
  })
})
