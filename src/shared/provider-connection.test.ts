import { describe, expect, it } from 'vitest'
import { PROVIDER_COMPANIES, type ProviderConnectionView } from '@clave/contract/settings'
import { isConnectionPoolId, poolAccountOf } from './connection'
import { providerConnection, providerPoolOf } from './provider-connection'

/** A made-up stored connection: no key value anywhere, only whether one is stored. */
function view(overrides: Partial<ProviderConnectionView> = {}): ProviderConnectionView {
  return {
    id: 'conn-1',
    label: 'Moonshot',
    company: 'moonshot',
    kind: 'key',
    pool: 'moonshot',
    endpoints: [{ wireFormat: 'openai-chat', baseUrl: 'https://api.example.test/v1' }],
    needsKey: true,
    hasKey: false,
    keySetAt: null,
    createdAt: 1,
    ...overrides
  }
}

describe('a provider connection in the one shape of a connection', () => {
  it('is usable once its key is stored, and not before', () => {
    expect(providerConnection(view()).usable).toBe(false)
    expect(providerConnection(view({ hasKey: true, keySetAt: 2 })).usable).toBe(true)
  })

  it('is usable without a key when its company takes none (Ollama)', () => {
    const ollama = view({
      label: 'Ollama',
      company: 'ollama',
      pool: 'ollama',
      needsKey: false,
      hasKey: false
    })
    expect(providerConnection(ollama).usable).toBe(true)
  })

  it('is a key in its company pool, reporting no usage', () => {
    const connection = providerConnection(view({ hasKey: true }))
    expect(connection).toMatchObject({
      id: 'conn-1',
      label: 'Moonshot',
      pool: 'moonshot',
      company: 'moonshot',
      kind: 'key',
      reportsUsage: false
    })
    expect(connection.usage).toBeUndefined()
  })

  it('is the pool rule fallback, since it reports no quota', () => {
    expect(poolAccountOf(providerConnection(view({ hasKey: true })))).toEqual({
      id: 'conn-1',
      usable: true,
      fallback: true
    })
  })

  it('belongs to the pool named after its company in the catalogue', () => {
    const pool = providerPoolOf(view())
    expect(pool.id).toBe('moonshot')
    expect(pool.company.name).toBe(PROVIDER_COMPANIES.find((c) => c.id === 'moonshot')?.name)
    expect(pool.reportsUsage).toBe(false)
  })

  it('names a registered pool id, and an unknown company none', () => {
    expect(isConnectionPoolId('moonshot')).toBe(true)
    expect(isConnectionPoolId('acme')).toBe(false)
  })
})
