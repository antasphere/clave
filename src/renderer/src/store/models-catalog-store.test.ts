import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelsCatalogView } from '@clave/contract/settings/models-catalog-view'
import {
  CATALOG_FRESH_MS,
  USAGE_LINE_FRESH_MS,
  ensureModelsCatalog,
  ensureUsageLine,
  modelsCatalogFor,
  resetModelsCatalogStores,
  usageLineTextFor
} from './models-catalog-store'

const VIEW: ModelsCatalogView = {
  fetchedAt: 1,
  stale: false,
  providers: [{ id: 'deepseek', name: 'DeepSeek', models: [] }]
}

let now = 1_000_000
beforeEach(() => {
  resetModelsCatalogStores()
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => vi.restoreAllMocks())

describe('ensureModelsCatalog', () => {
  it('reads once per machine', async () => {
    const read = vi.fn(async () => VIEW)
    await ensureModelsCatalog('local', read)
    await ensureModelsCatalog('local', read)
    expect(read).toHaveBeenCalledTimes(1)
    expect(modelsCatalogFor('local')).toMatchObject({ status: 'ready', view: VIEW, readAt: now })
    await ensureModelsCatalog('server-1', read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reads again after an hour, not before', async () => {
    const read = vi.fn(async () => VIEW)
    await ensureModelsCatalog('local', read)
    now += CATALOG_FRESH_MS - 1
    await ensureModelsCatalog('local', read)
    expect(read).toHaveBeenCalledTimes(1)
    now += 1
    await ensureModelsCatalog('local', read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reads again when the providers asked for change', async () => {
    const read = vi.fn(async () => VIEW)
    await ensureModelsCatalog('local', read, 'deepseek')
    await ensureModelsCatalog('local', read, 'deepseek\u0000mistral')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('never reads twice at once, and says loading meanwhile', async () => {
    let resolve!: (view: ModelsCatalogView) => void
    const read = vi.fn(() => new Promise<ModelsCatalogView>((r) => (resolve = r)))
    const first = ensureModelsCatalog('local', read)
    const second = ensureModelsCatalog('local', read)
    await Promise.resolve()
    expect(modelsCatalogFor('local')?.status).toBe('loading')
    resolve(VIEW)
    await Promise.all([first, second])
    expect(read).toHaveBeenCalledTimes(1)
    expect(modelsCatalogFor('local')?.status).toBe('ready')
  })

  it('a failed read is failed, keeps the copy before it, and is tried again', async () => {
    await ensureModelsCatalog('local', async () => VIEW)
    now += CATALOG_FRESH_MS
    await ensureModelsCatalog('local', async () => {
      throw new Error('offline')
    })
    expect(modelsCatalogFor('local')).toMatchObject({ status: 'failed', view: VIEW })
    const read = vi.fn(async () => VIEW)
    await ensureModelsCatalog('local', read)
    expect(read).toHaveBeenCalledTimes(1)
    expect(modelsCatalogFor('local')?.status).toBe('ready')
  })
})

describe('ensureUsageLine', () => {
  it('reads a line once per five minutes, per machine and connection', async () => {
    const read = vi.fn(async () => ({ kind: 'payPerUse' as const }))
    expect(usageLineTextFor('local', 'c1')).toBeNull()
    await ensureUsageLine('local', 'c1', read)
    expect(usageLineTextFor('local', 'c1')).toBe('Pay per use')
    now += USAGE_LINE_FRESH_MS - 1
    await ensureUsageLine('local', 'c1', read)
    expect(read).toHaveBeenCalledTimes(1)
    await ensureUsageLine('server-1', 'c1', read)
    await ensureUsageLine('local', 'c2', read)
    expect(read).toHaveBeenCalledTimes(3)
    now += 1
    await ensureUsageLine('local', 'c1', read)
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('never reads a line twice at once, and a rejection reads as unknown', async () => {
    let reject!: (error: Error) => void
    const read = vi.fn(
      () =>
        new Promise<{ kind: 'plan' }>((_, r) => {
          reject = r
        })
    )
    const first = ensureUsageLine('local', 'c1', read)
    const second = ensureUsageLine('local', 'c1', read)
    expect(usageLineTextFor('local', 'c1')).toBeNull()
    await Promise.resolve()
    reject(new Error('down'))
    await Promise.all([first, second])
    expect(read).toHaveBeenCalledTimes(1)
    expect(usageLineTextFor('local', 'c1')).toBe('Usage unknown')
  })
})
