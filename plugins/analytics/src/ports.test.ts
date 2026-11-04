import { describe, expect, it } from 'vitest'
import { emptyLedger, type Ledger } from './ledger'
import { settingsPort, type LiveLedger, type SettingsStore } from './ports'
import type { PriceTable } from './prices'
import type { Settings } from './settings'

/**
 * The settings port the plugin's main hands the server, driven with fakes: what each patch
 * writes and applies.
 */

const table = (date: string): PriceTable => ({
  source: `a table of ${date}`,
  date,
  models: {}
})

function fakeStore(): SettingsStore & { written: Settings[]; prices: PriceTable | null } {
  const store = {
    written: [] as Settings[],
    prices: null as PriceTable | null,
    writeSettings(settings: Settings): void {
      store.written.push(settings)
    },
    hasPrices(): boolean {
      return store.prices !== null
    },
    writePrices(next: PriceTable): void {
      store.prices = next
    },
    removePrices(): void {
      store.prices = null
    }
  }
  return store
}

function fakeCollector(
  ledger: Ledger = emptyLedger(15)
): LiveLedger & { gaps: number[]; touches: number } {
  const live = {
    ledger,
    gaps: [] as number[],
    touches: 0,
    setGap(minutes: number): void {
      live.gaps.push(minutes)
      live.ledger.gapMinutes = minutes
    },
    touch(): void {
      live.touches++
    }
  }
  return live
}

describe('the settings port', () => {
  it("reads the state in force: the gap from the ledger, the table and whether it is the person's own", () => {
    const store = fakeStore()
    const port = settingsPort({
      store,
      collector: fakeCollector(emptyLedger(90)),
      shipped: table('2026-11-03'),
      prices: () => (store.prices ? store.prices : table('2026-11-03'))
    })
    expect(port.get()).toEqual({
      gapMinutes: 90,
      gapBounds: { min: 1, max: 1440 },
      prices: table('2026-11-03'),
      override: false,
      shipped: { date: '2026-11-03', source: 'a table of 2026-11-03' }
    })
  })

  it('writes a new gap to the file and applies it to the collector, without re-pricing', () => {
    const store = fakeStore()
    const collector = fakeCollector()
    const seen: PriceTable[] = []
    const port = settingsPort({
      store,
      collector,
      shipped: table('2026-11-03'),
      prices: () => table('2026-11-03'),
      onTable: (next) => seen.push(next)
    })
    const after = port.apply({ gapMinutes: 20 })
    expect(store.written).toEqual([{ gapMinutes: 20 }])
    expect(collector.gaps).toEqual([20])
    expect(after.gapMinutes).toBe(20)
    expect(collector.touches).toBe(0)
    expect(seen).toEqual([])
  })

  it('writes a price table as the override, re-prices every page, and takes it back on reset', () => {
    const store = fakeStore()
    const collector = fakeCollector()
    const seen: PriceTable[] = []
    const port = settingsPort({
      store,
      collector,
      shipped: table('2026-11-03'),
      prices: () => (store.prices ? store.prices : table('2026-11-03')),
      onTable: (next) => seen.push(next)
    })
    const own = table('2026-11-04')
    const after = port.apply({ prices: own })
    expect(store.prices).toEqual(own)
    expect(after.override).toBe(true)
    expect(after.prices).toEqual(own)
    expect(seen).toEqual([own])
    expect(collector.touches).toBe(1)
    expect(store.written).toEqual([])

    const reset = port.apply({ resetPrices: true })
    expect(store.prices).toBeNull()
    expect(reset.override).toBe(false)
    expect(reset.prices).toEqual(table('2026-11-03'))
    expect(seen).toEqual([own, table('2026-11-03')])
    expect(collector.touches).toBe(2)
  })
})
