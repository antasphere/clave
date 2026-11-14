import { describe, expect, it } from 'vitest'
import {
  PROVIDER_COMPANIES,
  PROVIDER_COMPANY_IDS
} from '@clave/contract/settings/provider-catalogue'
import {
  CLAVE_CONNECTION_KEY_ENV,
  PI_PROVIDER_CREDENTIAL_ENV_VARS,
  PROVIDER_KEY_ENV_VARS,
  piForeignCredentialVars,
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

  // The verifier's F1 (PRDCT-4496): Pi lists and spends any provider it finds
  // a credential for, so a Pi process on a connection starts without these.
  it('PI_PROVIDER_CREDENTIAL_ENV_VARS is sorted, unique, and holds every credential Pi documents', () => {
    const list = [...PI_PROVIDER_CREDENTIAL_ENV_VARS]
    expect(list).toEqual([...list].sort())
    expect(new Set(list).size).toBe(list.length)
    for (const name of list) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
    // Pi 1.5.2's docs/providers.md key table, Anthropic's tokens, Azure,
    // Cloudflare, Bedrock's and Vertex's ambient credentials.
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_OAUTH_TOKEN',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'COPILOT_GITHUB_TOKEN',
      'GROQ_API_KEY',
      'XAI_API_KEY',
      'HF_TOKEN',
      'MOONSHOT_API_KEY',
      'OPENCODE_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'CLOUDFLARE_API_KEY',
      'AWS_PROFILE',
      'AWS_ACCESS_KEY_ID',
      'AWS_BEARER_TOKEN_BEDROCK',
      'GOOGLE_CLOUD_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_PROJECT'
    ])
      expect(list).toContain(name)
    // Every variable a Pi road of Clave's reads, and Clave's own.
    expect(list).toContain(CLAVE_CONNECTION_KEY_ENV)
    for (const road of PROVIDER_ROADS) if (road.pi) expect(list).toContain(road.pi.env)
  })

  it("piForeignCredentialVars keeps out every one of them but the connection's own", () => {
    const foreign = piForeignCredentialVars({ KIMI_API_KEY: 'made-up', PI_CODING_AGENT_DIR: '/d' })
    expect(foreign).not.toContain('KIMI_API_KEY')
    expect(foreign).toContain('ANTHROPIC_API_KEY')
    expect(foreign).toContain(CLAVE_CONNECTION_KEY_ENV)
    expect(foreign).toHaveLength(PI_PROVIDER_CREDENTIAL_ENV_VARS.length - 1)
    expect(piForeignCredentialVars({ [CLAVE_CONNECTION_KEY_ENV]: 'made-up' })).not.toContain(
      CLAVE_CONNECTION_KEY_ENV
    )
  })
})
