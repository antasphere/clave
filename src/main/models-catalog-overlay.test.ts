import { describe, expect, it } from 'vitest'
import {
  CLAVE_CONNECTION_KEY_ENV,
  PROVIDER_COMPANIES,
  PROVIDER_COMPANY_BY_ID,
  PROVIDER_KEY_ENV_VARS,
  envForHarness,
  type ProviderCompanyId
} from './models-catalog-overlay'

// The overlay on models.dev (PRDCT-4496): pure data, checked for shape.

const IDS: ProviderCompanyId[] = [
  'moonshot',
  'zai',
  'deepseek',
  'minimax',
  'alibaba',
  'mistral',
  'openrouter',
  'vercel',
  'ollama',
  'custom'
]

describe('the provider companies overlay', () => {
  it('every row has a non-empty name and a catalog id that is a non-empty string or null', () => {
    for (const company of PROVIDER_COMPANIES) {
      expect(company.name.trim()).not.toBe('')
      if (company.catalog !== null) expect(company.catalog.trim()).not.toBe('')
    }
  })

  it('the ten ids are unique and the index has them all', () => {
    const ids = PROVIDER_COMPANIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([...IDS].sort())
    for (const id of IDS) expect(PROVIDER_COMPANY_BY_ID[id].id).toBe(id)
    expect(Object.keys(PROVIDER_COMPANY_BY_ID).sort()).toEqual([...IDS].sort())
  })

  it('envForHarness falls back on the connection variable where the harness ships no provider', () => {
    expect(CLAVE_CONNECTION_KEY_ENV).toBe('CLAVE_CONNECTION_API_KEY')
    expect(envForHarness('alibaba', 'pi')).toBe('CLAVE_CONNECTION_API_KEY')
    expect(envForHarness('alibaba', 'opencode')).toBe('ALIBABA_CODING_PLAN_API_KEY')
    expect(envForHarness('zai', 'pi')).toBe('ZAI_API_KEY')
    expect(envForHarness('zai', 'opencode')).toBe('ZHIPU_API_KEY')
    expect(envForHarness('custom', 'opencode')).toBe('CLAVE_CONNECTION_API_KEY')
  })

  it('PROVIDER_KEY_ENV_VARS is sorted, unique, complete, and holds only variable names', () => {
    const list = [...PROVIDER_KEY_ENV_VARS]
    expect(list).toEqual([...list].sort())
    expect(new Set(list).size).toBe(list.length)
    for (const name of ['KIMI_API_KEY', 'ZHIPU_API_KEY', 'ZAI_API_KEY', 'CLAVE_CONNECTION_API_KEY'])
      expect(list).toContain(name)
    for (const company of PROVIDER_COMPANIES)
      for (const road of [company.pi, company.opencode]) if (road) expect(list).toContain(road.env)
    for (const name of list) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
  })
})
