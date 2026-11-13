import { describe, expect, it } from 'vitest'
import {
  PROVIDER_COMPANIES,
  PROVIDER_COMPANY_IDS
} from '@clave/contract/settings/provider-catalogue'
import {
  CLAVE_CONNECTION_KEY_ENV,
  PROVIDER_KEY_ENV_VARS,
  PROVIDER_LISTING_FACTS,
  PROVIDER_ROADS,
  PROVIDER_ROAD_BY_ID,
  envForHarness
} from './models-catalog-overlay'

// The overlay on models.dev (PRDCT-4496): pure data keyed on lane B's ids,
// checked for shape.

describe('the provider roads overlay', () => {
  it('has a row for every company of the catalogue, keyed on its id, and no other', () => {
    const ids = PROVIDER_ROADS.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([...PROVIDER_COMPANY_IDS].sort())
    for (const id of PROVIDER_COMPANY_IDS) expect(PROVIDER_ROAD_BY_ID[id].id).toBe(id)
    expect(Object.keys(PROVIDER_ROAD_BY_ID).sort()).toEqual([...PROVIDER_COMPANY_IDS].sort())
  })

  it('carries no name, endpoint, wire or usage of its own: the catalogue and the usage table own them', () => {
    for (const road of PROVIDER_ROADS)
      expect(Object.keys(road).sort()).toEqual(['catalog', 'id', 'opencode', 'pi'])
  })

  it('every catalog id is a non-empty string or null', () => {
    for (const road of PROVIDER_ROADS)
      if (road.catalog !== null) expect(road.catalog.trim()).not.toBe('')
    expect(PROVIDER_ROAD_BY_ID['vercel-ai-gateway'].catalog).toBe('vercel')
    expect(PROVIDER_ROAD_BY_ID.generic.catalog).toBeNull()
  })

  it("the listing facts take the catalogue's name and the road's models.dev provider", () => {
    for (const company of PROVIDER_COMPANIES)
      expect(PROVIDER_LISTING_FACTS[company.id]).toEqual({
        name: company.name,
        catalog: PROVIDER_ROAD_BY_ID[company.id].catalog
      })
  })

  it('envForHarness falls back on the connection variable where the harness ships no provider', () => {
    expect(CLAVE_CONNECTION_KEY_ENV).toBe('CLAVE_CONNECTION_API_KEY')
    expect(envForHarness('alibaba', 'pi')).toBe('CLAVE_CONNECTION_API_KEY')
    expect(envForHarness('alibaba', 'opencode')).toBe('ALIBABA_CODING_PLAN_API_KEY')
    expect(envForHarness('zai', 'pi')).toBe('ZAI_API_KEY')
    expect(envForHarness('zai', 'opencode')).toBe('ZHIPU_API_KEY')
    expect(envForHarness('generic', 'opencode')).toBe('CLAVE_CONNECTION_API_KEY')
    expect(envForHarness('vercel-ai-gateway', 'pi')).toBe('AI_GATEWAY_API_KEY')
  })

  it('PROVIDER_KEY_ENV_VARS is sorted, unique, complete, and holds only variable names', () => {
    const list = [...PROVIDER_KEY_ENV_VARS]
    expect(list).toEqual([...list].sort())
    expect(new Set(list).size).toBe(list.length)
    for (const name of ['KIMI_API_KEY', 'ZHIPU_API_KEY', 'ZAI_API_KEY', 'CLAVE_CONNECTION_API_KEY'])
      expect(list).toContain(name)
    for (const road of PROVIDER_ROADS)
      for (const harness of [road.pi, road.opencode])
        if (harness) expect(list).toContain(harness.env)
    for (const name of list) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
  })
})
