import { describe, expect, it } from 'vitest'
import type {
  CatalogModelView,
  ModelsCatalogView
} from '@clave/contract/settings/models-catalog-view'
import { PROVIDER_LISTING_FACTS } from '../main/models-catalog-overlay'
import {
  DEFAULT_PROVIDER_MODEL,
  connectionsServingModel,
  modelsForProviderConnections
} from './launch-models'

const model = (id: string, status?: 'deprecated' | 'beta'): CatalogModelView => ({
  id,
  name: `${id} name`,
  reasoning: true,
  toolCall: true,
  ...(status ? { status } : {})
})

const VIEW: ModelsCatalogView = {
  fetchedAt: 1,
  stale: false,
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [model('deepseek-chat'), model('deepseek-old', 'deprecated')]
    },
    { id: 'openrouter', name: 'OpenRouter', models: [model('or-a'), model('deepseek-chat')] },
    { id: 'mistral', name: 'Mistral', models: [model('devstral')] }
  ]
}

const ids = (rows: ReturnType<typeof modelsForProviderConnections>): unknown =>
  rows === 'loading' ? rows : rows.map((row) => row.id)

describe('modelsForProviderConnections', () => {
  it('lists the default, then each connection’s company models in the connections’ order', () => {
    const rows = modelsForProviderConnections(
      VIEW,
      [
        { id: 'c-or', company: 'openrouter' },
        { id: 'c-ds', company: 'deepseek' }
      ],
      PROVIDER_LISTING_FACTS
    )
    expect(ids(rows)).toEqual([undefined, 'or-a', 'deepseek-chat'])
    expect(rows !== 'loading' && rows[0]).toEqual(DEFAULT_PROVIDER_MODEL)
    // The first company that lists a model names it.
    expect(rows !== 'loading' && rows[2]).toEqual({
      id: 'deepseek-chat',
      label: 'deepseek-chat name',
      family: 'OpenRouter'
    })
  })

  it('deduplicates across connections and against the pinned models, deprecated hidden', () => {
    const rows = modelsForProviderConnections(
      VIEW,
      [
        { id: 'c-ds', company: 'deepseek' },
        { id: 'c-ds2', company: 'deepseek' },
        { id: 'c-or', company: 'openrouter' }
      ],
      PROVIDER_LISTING_FACTS,
      ['qwen3', 'or-a', 'qwen3']
    )
    expect(ids(rows)).toEqual([undefined, 'deepseek-chat', 'or-a', 'qwen3'])
  })

  it('says loading while the catalogue a connection waits on is read', () => {
    expect(
      modelsForProviderConnections(
        'loading',
        [{ id: 'c', company: 'deepseek' }],
        PROVIDER_LISTING_FACTS
      )
    ).toBe('loading')
    // No connection, or none with a catalogue: nothing to wait for.
    expect(ids(modelsForProviderConnections('loading', [], PROVIDER_LISTING_FACTS, ['p']))).toEqual(
      [undefined, 'p']
    )
    expect(
      ids(
        modelsForProviderConnections(
          'loading',
          [{ id: 'c', company: 'ollama' }],
          PROVIDER_LISTING_FACTS
        )
      )
    ).toEqual([undefined])
  })

  it('lists no catalogue model for a company with no catalogue, nor with no catalogue read', () => {
    expect(
      ids(
        modelsForProviderConnections(
          VIEW,
          [
            { id: 'c1', company: 'generic' },
            { id: 'c2', company: 'ollama' }
          ],
          PROVIDER_LISTING_FACTS
        )
      )
    ).toEqual([undefined])
    expect(
      ids(
        modelsForProviderConnections(
          null,
          [{ id: 'c', company: 'deepseek' }],
          PROVIDER_LISTING_FACTS
        )
      )
    ).toEqual([undefined])
  })
})

describe('connectionsServingModel', () => {
  const connections = [
    { id: 'c-ds', company: 'deepseek' as const },
    { id: 'c-or', company: 'openrouter' as const },
    { id: 'c-ol', company: 'ollama' as const }
  ]
  it('offers every connection for the default row', () => {
    expect(
      connectionsServingModel(VIEW, connections, PROVIDER_LISTING_FACTS, undefined).map((c) => c.id)
    ).toEqual(['c-ds', 'c-or', 'c-ol'])
  })
  it('offers the connections whose company lists the model, deprecated not', () => {
    const serving = (id: string): string[] =>
      connectionsServingModel(VIEW, connections, PROVIDER_LISTING_FACTS, id).map((c) => c.id)
    expect(serving('deepseek-chat')).toEqual(['c-ds', 'c-or'])
    expect(serving('or-a')).toEqual(['c-or'])
    expect(serving('deepseek-old')).toEqual([])
  })
})
