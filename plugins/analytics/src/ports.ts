import type { Ledger } from './ledger'
import type { PriceTable } from './prices'
import {
  publishDeck as realPublishDeck,
  type PublishDeps,
  type PublishOutcome,
  type PublishRequest
} from './publish'
import type { SettingsData, SettingsPatch, SettingsPort } from './server'
import { GAP_MAX, GAP_MIN, type Settings } from './settings'

/**
 * What the plugin's main hands the server, apart from `main.ts` so a test can drive them:
 * the settings port (the gap and the price table, read from the data folder, written there
 * and applied to the open pages at once) and the publisher (one publish at a time per page,
 * the deck it answers kept in the ledger and written out before anything else happens).
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

export interface PublisherDeps {
  /** The plugin's data folder. */
  dir: string
  /** Where the built page lives. */
  pageDir: string
  collector: LiveLedger
  /** Writes the ledger now: a deck on record must not wait for the next debounced write. */
  flush: () => void
  log?: (level: 'info' | 'warn', message: string) => void
  /** The publish of one deck; the real one by default. */
  publishDeck?: (deps: PublishDeps) => Promise<PublishOutcome>
}

export const BUSY: PublishOutcome = {
  ok: false,
  kind: 'busy',
  message: 'This page is being published already.'
}

/** One publish at a time per page: a second click while one runs is told so. A deck the
 *  CLI answered goes on the ledger at once; a deck reported gone leaves it. */
export function publisher(
  deps: PublisherDeps
): (request: PublishRequest) => Promise<PublishOutcome> {
  const inFlight = new Set<string>()
  const publishOne = deps.publishDeck ?? realPublishDeck
  return async (request: PublishRequest): Promise<PublishOutcome> => {
    if (inFlight.has(request.key)) return BUSY
    inFlight.add(request.key)
    try {
      const outcome = await publishOne({
        dir: deps.dir,
        pageDir: deps.pageDir,
        request,
        existing: deps.collector.ledger.published[request.key] ?? null
      })
      if (outcome.ok) {
        deps.collector.ledger.published[request.key] = outcome.deck
        deps.collector.touch()
        deps.flush()
        deps.log?.(
          'info',
          `Published ${request.key} as deck ${outcome.deck.deckId} version ${outcome.deck.version}`
        )
      } else if (outcome.gone) {
        delete deps.collector.ledger.published[request.key]
        deps.collector.touch()
        deps.flush()
      }
      return outcome
    } finally {
      inFlight.delete(request.key)
    }
  }
}
