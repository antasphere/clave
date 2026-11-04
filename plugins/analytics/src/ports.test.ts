import { describe, expect, it } from 'vitest'
import { emptyLedger, type Ledger, type PublishedDeck } from './ledger'
import { BUSY, publisher, settingsPort, type LiveLedger, type SettingsStore } from './ports'
import type { PriceTable } from './prices'
import type { PublishDeps, PublishOutcome, PublishRequest } from './publish'
import type { ScopeView } from './ledger'
import type { Settings } from './settings'

/**
 * The two ports the plugin's main hands the server, driven with fakes: what each patch
 * writes and applies, and what a publish does to the ledger in every outcome.
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

describe('the publisher', () => {
  const deck: PublishedDeck = {
    deckId: 'deck-7',
    baseUrl: 'https://share.example',
    url: 'https://share.example/p/deck-7',
    version: 1,
    n: 1,
    at: '2026-11-04T15:00:00.000Z',
    title: 'Theme · Analytics',
    names: false
  }
  const view = { kind: 'group', id: 'g1', name: 'Theme' } as unknown as ScopeView
  const request = (key = 'group:g1'): PublishRequest => ({
    key,
    range: 'all',
    names: false,
    theme: 'dark',
    tokens: {},
    data: view
  })

  function harness(answer: (deps: PublishDeps) => Promise<PublishOutcome>): {
    run: (request: PublishRequest) => Promise<PublishOutcome>
    collector: ReturnType<typeof fakeCollector>
    given: PublishDeps[]
    flushes: number
  } {
    const collector = fakeCollector()
    const given: PublishDeps[] = []
    const state = { flushes: 0 }
    const run = publisher({
      dir: '/data',
      pageDir: '/page',
      collector,
      flush: () => state.flushes++,
      publishDeck: (deps) => {
        given.push(deps)
        return answer(deps)
      }
    })
    return {
      run,
      collector,
      given,
      get flushes(): number {
        return state.flushes
      }
    }
  }

  it('puts the deck the CLI answered on the ledger, wakes the pages and writes the ledger', async () => {
    const h = harness(async () => ({ ok: true, deck }))
    const outcome = await h.run(request())
    expect(outcome).toEqual({ ok: true, deck })
    expect(h.given[0]).toMatchObject({ dir: '/data', pageDir: '/page', existing: null })
    expect(h.given[0]!.request.key).toBe('group:g1')
    expect(h.collector.ledger.published['group:g1']).toEqual(deck)
    expect(h.collector.touches).toBe(1)
    expect(h.flushes).toBe(1)
    // The next publish of the same page gets the deck on record.
    await h.run(request())
    expect(h.given[1]!.existing).toEqual(deck)
  })

  it('refuses a second publish of the same page while one runs, and lets another page through', async () => {
    const releases: (() => void)[] = []
    const h = harness(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true, deck }))
        })
    )
    const first = h.run(request())
    const second = await h.run(request())
    expect(second).toEqual(BUSY)
    const other = h.run(request('group:g2'))
    expect(h.given).toHaveLength(2)
    releases[0]!()
    await first
    releases[1]!()
    await other
    expect(h.given.map((d) => d.request.key)).toEqual(['group:g1', 'group:g2'])
    expect(h.collector.ledger.published['group:g1']).toEqual(deck)
    expect(h.collector.ledger.published['group:g2']).toEqual(deck)
    const third = h.run(request())
    releases[2]!()
    expect((await third).ok).toBe(true)
  })

  it('drops the deck on record when the CLI says it is gone, and leaves it on any other failure', async () => {
    const h = harness(async (deps) =>
      deps.existing
        ? { ok: false, kind: 'failed', message: 'gone', gone: true }
        : { ok: false, kind: 'auth', message: 'not signed in' }
    )
    h.collector.ledger.published['group:g1'] = deck
    const gone = await h.run(request())
    expect(gone).toMatchObject({ ok: false, gone: true })
    expect(h.collector.ledger.published['group:g1']).toBeUndefined()
    expect(h.collector.touches).toBe(1)
    expect(h.flushes).toBe(1)
    const refused = await h.run(request())
    expect(refused).toEqual({ ok: false, kind: 'auth', message: 'not signed in' })
    expect(h.collector.touches).toBe(1)
    expect(h.flushes).toBe(1)
  })
})
