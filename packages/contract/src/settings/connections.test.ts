import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import {
  PROVIDER_COMPANIES,
  ProviderConnectionsChanged,
  ProviderConnectionView,
  connectionServes,
  providerCompany
} from './connections'

/**
 * The provider catalogue and the connection view (PRDCT-4426): ten cards in
 * a fixed order, every company endpoint a real http(s) URL, and a view that
 * never carries a key.
 */
describe('the provider connections contract', () => {
  it('lists the ten cards, unique, in the order of the Connections page', () => {
    expect(PROVIDER_COMPANIES.map((c) => c.id)).toEqual([
      'moonshot',
      'zai',
      'mistral',
      'deepseek',
      'minimax',
      'alibaba',
      'openrouter',
      'vercel-ai-gateway',
      'ollama',
      'generic'
    ])
    expect(new Set(PROVIDER_COMPANIES.map((c) => c.id)).size).toBe(10)
  })

  it('gives every company but the generic card at least one http(s) endpoint', () => {
    for (const company of PROVIDER_COMPANIES) {
      if (company.id === 'generic') {
        expect(company.endpoints).toEqual([])
        continue
      }
      expect(company.endpoints.length, company.id).toBeGreaterThan(0)
      for (const endpoint of company.endpoints) {
        expect(() => new URL(endpoint.baseUrl), endpoint.baseUrl).not.toThrow()
        expect(endpoint.baseUrl).toMatch(/^https?:\/\//)
      }
    }
  })

  it('asks a key of every company but Ollama', () => {
    for (const company of PROVIDER_COMPANIES) {
      expect(company.needsKey, company.id).toBe(company.id !== 'ollama')
    }
    expect(providerCompany('moonshot').plan).toBe('Kimi Code')
  })

  it('serves a harness through a wire format it speaks, and none through no format', () => {
    const connection = {
      endpoints: [{ wireFormat: 'anthropic-messages' as const, baseUrl: 'https://x.test' }]
    }
    expect(
      connectionServes(connection, ['anthropic-messages', 'openai-chat', 'openai-responses'])
    ).toBe(true)
    expect(connectionServes(connection, ['anthropic-messages'])).toBe(true)
    expect(connectionServes(connection, ['openai-responses'])).toBe(false)
    expect(connectionServes(connection, [])).toBe(false)
  })

  it('decodes a connection view, and never keeps a key given to it', () => {
    const sample = {
      id: 'c1',
      label: 'Moonshot',
      company: 'moonshot',
      kind: 'key',
      pool: 'moonshot',
      endpoints: [{ wireFormat: 'openai-chat', baseUrl: 'https://api.kimi.ai/coding/v1' }],
      needsKey: true,
      hasKey: true,
      keySetAt: 1,
      createdAt: 1
    }
    expect(Schema.decodeUnknownSync(ProviderConnectionView)(sample)).toEqual(sample)
    let decoded: unknown
    try {
      decoded = Schema.decodeUnknownSync(ProviderConnectionView)({
        ...sample,
        apiKey: 'sk-contract-should-not-stay'
      })
    } catch {
      decoded = undefined
    }
    if (decoded !== undefined) expect(decoded).not.toHaveProperty('apiKey')
    expect(JSON.stringify(decoded ?? null)).not.toContain('sk-contract')
  })

  it('pushes the list under the accounts domain', () => {
    expect(ProviderConnectionsChanged.make({ connections: [] })._tag).toBe(
      'accounts.providers_changed'
    )
    expect(providerCompany('generic').name).toBe('Another provider')
  })
})
