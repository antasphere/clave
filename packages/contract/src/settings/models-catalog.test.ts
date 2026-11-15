import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import { ReadModelsCatalog } from './index'
import {
  CATALOG_MODEL_STATUSES,
  catalogModelsOf,
  type ModelsCatalogView
} from './models-catalog-view'

// The models catalogue's wire shape (PRDCT-4496): the answer the server sends
// is the view the window reads, and the query's payload is read off the URL.

const SAMPLE: ModelsCatalogView = {
  fetchedAt: 1_800_000_000_000,
  stale: true,
  error: 'Clave could not reach models.dev.',
  providers: [
    {
      id: 'acme-ai',
      name: 'Acme AI',
      models: [
        { id: 'old', name: 'Old', reasoning: false, toolCall: true, status: 'deprecated' },
        { id: 'next', name: 'Next', reasoning: true, toolCall: false, status: 'alpha' },
        {
          id: 'main',
          name: 'Main',
          reasoning: true,
          toolCall: true,
          contextLimit: 200000,
          outputLimit: 32000
        }
      ]
    }
  ]
}

describe('ReadModelsCatalog', () => {
  const success = ReadModelsCatalog.success as unknown as Schema.Schema<unknown, unknown>

  it('carries a catalogue through the wire unchanged, a never-fetched one too', () => {
    const encoded = Schema.encodeUnknownSync(success)(SAMPLE)
    expect(Schema.decodeUnknownSync(success)(JSON.parse(JSON.stringify(encoded)))).toEqual(SAMPLE)
    const empty = { fetchedAt: null, stale: false, providers: [] }
    expect(Schema.decodeUnknownSync(success)(empty)).toEqual(empty)
  })

  it('refuses a status outside the three', () => {
    expect(CATALOG_MODEL_STATUSES).toEqual(['deprecated', 'beta', 'alpha'])
    const bad = structuredClone(SAMPLE) as unknown as {
      providers: Array<{ models: Array<{ status?: string }> }>
    }
    bad.providers[0].models[0].status = 'retired'
    expect(Either.isLeft(Schema.decodeUnknownEither(success)(bad))).toBe(true)
    expect(Either.isLeft(Schema.encodeUnknownEither(success)(bad))).toBe(true)
  })

  it('reads the ids comma-joined and the flag as a string, both optional', () => {
    const payload = ReadModelsCatalog.payload as unknown as Schema.Schema<unknown, unknown>
    expect(Schema.decodeUnknownSync(payload)({ providerIds: 'b,a', force: 'true' })).toEqual({
      providerIds: ['b', 'a'],
      force: true
    })
    expect(Schema.decodeUnknownSync(payload)({})).toEqual({})
  })
})

describe('catalogModelsOf', () => {
  it('lists a provider’s models without the deprecated ones, [] for an unknown provider', () => {
    expect(catalogModelsOf(SAMPLE, 'acme-ai').map((m) => m.id)).toEqual(['next', 'main'])
    expect(catalogModelsOf(SAMPLE, 'nobody')).toEqual([])
  })
})
