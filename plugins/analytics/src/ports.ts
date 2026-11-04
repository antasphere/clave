import type { Ledger } from './ledger'
import type { PriceTable } from './prices'
import type { SettingsData, SettingsPatch, SettingsPort } from './server'
import { GAP_MAX, GAP_MIN, type Settings } from './settings'

/**
 * What the plugin's main hands the server, apart from `main.ts` so a test can drive it: the
 * settings port (the gap and the price table, read from the data folder, written there and
 * applied to the open pages at once).
 */

export interface SettingsStore {
  writeSettings(settings: Settings): void
  hasPrices(): boolean
  writePrices(table: PriceTable): void
  removePrices(): void
}

export interface LiveLedger {
  readonly ledger: Ledger
  setGap(minutes: number): void
  touch(): void
}

export interface SettingsPortDeps {
  store: SettingsStore
  collector: LiveLedger
  shipped: PriceTable
  /** The table in force, read afresh: the person's copy when it parses, else the shipped one. */
  prices: () => PriceTable
  /** Told the table in force after every change, so the server prices with it at once. */
  onTable?: (table: PriceTable) => void
}

export function settingsPort(deps: SettingsPortDeps): SettingsPort {
  const data = (): SettingsData => ({
    gapMinutes: deps.collector.ledger.gapMinutes,
    gapBounds: { min: GAP_MIN, max: GAP_MAX },
    prices: deps.prices(),
    override: deps.store.hasPrices(),
    shipped: { date: deps.shipped.date, source: deps.shipped.source }
  })
  return {
    get: data,
    apply(patch: SettingsPatch): SettingsData {
      if (patch.resetPrices) deps.store.removePrices()
      else if (patch.prices) deps.store.writePrices(patch.prices)
      if (patch.resetPrices || patch.prices) {
        // A new table re-prices every open page.
        deps.onTable?.(deps.prices())
        deps.collector.touch()
      }
      if (patch.gapMinutes !== undefined) {
        deps.store.writeSettings({ gapMinutes: patch.gapMinutes })
        deps.collector.setGap(patch.gapMinutes)
      }
      return data()
    }
  }
}
