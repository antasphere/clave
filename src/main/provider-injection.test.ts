import { describe, it, expect } from 'vitest'
import {
  opencodeConfiguredModel,
  opencodeModelRef,
  providerInjection,
  type ConnectionForSpawn
} from './provider-injection'
import {
  CLAVE_CONNECTION_KEY_ENV,
  PROVIDER_KEY_ENV_VARS,
  PROVIDER_ROAD_BY_ID
} from './models-catalog-overlay'
import {
  PROVIDER_COMPANIES,
  type ProviderCompanyId,
  type ProviderWireFormat
} from '@clave/contract/settings/provider-catalogue'
import type { CatalogModel } from './models-catalog'

/**
 * The rule (PRDCT-4496): the connection a tab names is the credential its
 * process uses. Its value rides in the environment under exactly one name,
 * and what the harness is told (OpenCode's inline config, Pi's models.json
 * entry) names that variable and never holds the value. The connection is
 * lane B's stored one: its company's id, and the endpoint the wiring chose.
 */

const VALUE = 'made-up-value-4496'

function connection(
  company: ProviderCompanyId,
  extra: Partial<ConnectionForSpawn> = {}
): ConnectionForSpawn {
  const first = PROVIDER_COMPANIES.find((c) => c.id === company)?.endpoints[0]
  return {
    id: `conn-${company}`,
    label: company,
    company,
    endpoint: first ? { wireFormat: first.wireFormat, baseUrl: first.baseUrl } : null,
    value: VALUE,
    ...extra
  }
}

/** The names of the env the value appears under. */
function namesHolding(env: Record<string, string>, value: string): string[] {
  return Object.entries(env)
    .filter(([, v]) => v.includes(value))
    .map(([k]) => k)
}

function configOf(env: Record<string, string>): Record<string, unknown> {
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>
}

const catalog: CatalogModel[] = [
  { id: 'qwen-a', name: 'Qwen A', reasoning: true, toolCall: true },
  { id: 'qwen-old', name: 'Qwen Old', reasoning: false, toolCall: true, status: 'deprecated' },
  { id: 'qwen-b', name: '', reasoning: false, toolCall: true }
]

describe('providerInjection without a connection (rule a)', () => {
  it('gives nothing when there is neither a connection nor a model', () => {
    expect(providerInjection({ harness: 'pi', connection: null })).toEqual({ env: {} })
    expect(providerInjection({ harness: 'opencode', connection: null })).toEqual({ env: {} })
  })

  it("leaves Pi's model on its command line", () => {
    expect(providerInjection({ harness: 'pi', connection: null, model: 'm' })).toEqual({ env: {} })
  })

  it("hands OpenCode's TUI its model inline, standalone", () => {
    const out = providerInjection({ harness: 'opencode', connection: null, model: 'deepseek/x' })
    expect(configOf(out.env)).toEqual({ model: 'deepseek/x' })
    expect(out.opencodeStandalone).toBe(true)
    expect(Object.keys(out.env)).toEqual(['OPENCODE_CONFIG_CONTENT'])
  })
})

describe('every company on every harness (rules b to f)', () => {
  for (const company of PROVIDER_COMPANIES) {
    for (const harness of ['pi', 'opencode'] as const) {
      it(`${company.id} on ${harness}`, () => {
        const conn = connection(company.id, {
          endpoint: company.endpoints[0] ?? {
            wireFormat: 'openai-chat',
            baseUrl: 'http://127.0.0.1:9/v1'
          },
          models: ['m-one']
        })
        const out = providerInjection({ harness, connection: conn, model: 'm-one' })
        const road = PROVIDER_ROAD_BY_ID[company.id][harness]
        const keyName = road ? road.env : CLAVE_CONNECTION_KEY_ENV
        // f: one name, and that name is one tmux carries.
        expect(namesHolding(out.env, VALUE)).toEqual([keyName])
        expect(PROVIDER_KEY_ENV_VARS).toContain(keyName)
        expect(JSON.parse(JSON.stringify(out))).toEqual(out)
        const providerId = road ? road.provider : `clave-${company.id}`
        if (harness === 'pi') {
          expect(out.piProvider).toBe(providerId)
          expect(out.piEntry?.providerId).toBe(providerId)
          expect(out.piEntry?.entry.apiKey).toBe(`$${keyName}`)
          expect(JSON.stringify(out.piEntry)).not.toContain(VALUE)
          expect(out.opencodeStandalone).toBeUndefined()
          expect(out.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
          // A provider Clave declares carries the catalogue's name.
          if (!road) expect(out.piEntry?.entry.name).toBe(company.name)
        } else {
          expect(out.opencodeStandalone).toBe(true)
          expect(out.env.OPENCODE_CONFIG_CONTENT).not.toContain(VALUE)
          const config = configOf(out.env) as {
            providers: Record<string, { name?: string; settings: { apiKey: string } }>
            model: string
          }
          expect(Object.keys(config.providers)).toEqual([providerId])
          expect(config.providers[providerId].settings.apiKey).toBe(`{env:${keyName}}`)
          expect(config.model).toBe(`${providerId}/m-one`)
          expect(out.piProvider).toBeUndefined()
          if (!road) expect(config.providers[providerId].name).toBe(company.name)
        }
      })
    }
  }
})

describe('a provider the harness ships (rules b and d)', () => {
  it('Pi: the key under the road variable, the entry the key alone', () => {
    const out = providerInjection({ harness: 'pi', connection: connection('deepseek') })
    expect(out).toEqual({
      env: { DEEPSEEK_API_KEY: VALUE },
      piProvider: 'deepseek',
      piEntry: { providerId: 'deepseek', entry: { apiKey: '$DEEPSEEK_API_KEY' } }
    })
  })

  it('OpenCode: the block holds the variable reference and nothing else', () => {
    const out = providerInjection({ harness: 'opencode', connection: connection('zai') })
    expect(out.env.ZHIPU_API_KEY).toBe(VALUE)
    expect(configOf(out.env)).toEqual({
      providers: { 'zai-coding-plan': { settings: { apiKey: '{env:ZHIPU_API_KEY}' } } },
      enabled_providers: ['zai-coding-plan']
    })
  })

  it('a road needs no endpoint: the harness reads its own', () => {
    const out = providerInjection({
      harness: 'pi',
      connection: connection('vercel-ai-gateway', { endpoint: null })
    })
    expect(out.piProvider).toBe('vercel-ai-gateway')
    expect(out.env).toEqual({ AI_GATEWAY_API_KEY: VALUE })
  })
})

describe('a provider Clave declares (rules c and e)', () => {
  it('Pi, Alibaba: the full entry, catalogue models first, deprecated left out', () => {
    const out = providerInjection({
      harness: 'pi',
      connection: connection('alibaba', { models: ['own-model', 'qwen-a'] }),
      model: 'picked',
      catalogModels: catalog
    })
    expect(out.env).toEqual({ [CLAVE_CONNECTION_KEY_ENV]: VALUE })
    expect(out.piProvider).toBe('clave-alibaba')
    expect(out.piEntry).toEqual({
      providerId: 'clave-alibaba',
      entry: {
        name: 'Alibaba',
        baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
        api: 'openai-completions',
        apiKey: '$CLAVE_CONNECTION_API_KEY',
        models: [
          { id: 'qwen-a', name: 'Qwen A' },
          { id: 'qwen-b', name: 'qwen-b' },
          { id: 'own-model', name: 'own-model' },
          { id: 'picked', name: 'picked' }
        ]
      }
    })
  })

  it('Ollama with no value: the word a local server ignores, at its stored base URL', () => {
    const out = providerInjection({
      harness: 'opencode',
      connection: connection('ollama', {
        value: null,
        models: ['llama'],
        endpoint: { wireFormat: 'openai-chat', baseUrl: 'http://10.0.0.9:11434/v1' }
      }),
      model: 'llama'
    })
    expect(out.env[CLAVE_CONNECTION_KEY_ENV]).toBe('ollama')
    expect(configOf(out.env)).toEqual({
      providers: {
        'clave-ollama': {
          name: 'Ollama',
          package: '@ai-sdk/openai-compatible',
          settings: {
            baseURL: 'http://10.0.0.9:11434/v1',
            apiKey: '{env:CLAVE_CONNECTION_API_KEY}'
          },
          models: { llama: { name: 'llama' } }
        }
      },
      enabled_providers: ['clave-ollama'],
      model: 'clave-ollama/llama'
    })
  })

  const WIRES: [ProviderWireFormat, string, string][] = [
    ['openai-chat', 'openai-completions', '@ai-sdk/openai-compatible'],
    ['openai-responses', 'openai-responses', '@ai-sdk/openai'],
    ['anthropic-messages', 'anthropic-messages', '@ai-sdk/anthropic']
  ]
  for (const [wireFormat, api, pkg] of WIRES)
    it(`a generic endpoint on ${wireFormat}: Pi's api ${api}, OpenCode's ${pkg}, its own base URL`, () => {
      const conn = connection('generic', {
        endpoint: { wireFormat, baseUrl: 'https://example.invalid/v1' }
      })
      const oc = configOf(providerInjection({ harness: 'opencode', connection: conn }).env) as {
        providers: Record<string, { name: string; package: string; settings: { baseURL: string } }>
      }
      expect(oc.providers['clave-generic']).toMatchObject({
        name: 'Another provider',
        package: pkg,
        settings: { baseURL: 'https://example.invalid/v1' }
      })
      const pi = providerInjection({ harness: 'pi', connection: conn })
      expect(pi.piEntry?.entry).toMatchObject({
        name: 'Another provider',
        api,
        baseUrl: 'https://example.invalid/v1'
      })
    })

  it('a connection Clave must declare with no endpoint is refused', () => {
    for (const harness of ['pi', 'opencode'] as const)
      for (const company of ['generic', 'ollama'] as const)
        expect(() =>
          providerInjection({ harness, connection: connection(company, { endpoint: null }) })
        ).toThrow('The connection has no endpoint.')
    expect(() =>
      providerInjection({ harness: 'pi', connection: connection('alibaba', { endpoint: null }) })
    ).toThrow('The connection has no endpoint.')
  })
})

// PRDCT-4427: an OpenCode CHAT on a connection. `opencode acp` 2.3.0 opens its
// session on the configuration's model and, with no model and no
// `enabled_providers`, on OpenCode's own free models (checked by hand on the
// real binary, a made-up key, 13 November 2026).
describe('OpenCode on a connection stays on it (PRDCT-4427)', () => {
  it('enables the connection’s provider alone, a road and a declared one alike, with or without a model', () => {
    for (const model of [undefined, 'k3']) {
      const road = configOf(
        providerInjection({ harness: 'opencode', connection: connection('moonshot'), model }).env
      )
      expect(road.enabled_providers).toEqual(['kimi-code-plan-global'])
      const declared = configOf(
        providerInjection({
          harness: 'opencode',
          connection: connection('generic', {
            endpoint: { wireFormat: 'openai-chat', baseUrl: 'https://example.invalid/v1' }
          }),
          model
        }).env
      )
      expect(declared.enabled_providers).toEqual(['clave-generic'])
    }
  })
  it('a model the agent reported back, `provider/model`, is never prefixed twice', () => {
    const fresh = configOf(
      providerInjection({ harness: 'opencode', connection: connection('moonshot'), model: 'k3' })
        .env
    )
    const restarted = configOf(
      providerInjection({
        harness: 'opencode',
        connection: connection('moonshot'),
        model: 'kimi-code-plan-global/k3'
      }).env
    )
    expect(fresh.model).toBe('kimi-code-plan-global/k3')
    expect(restarted.model).toBe('kimi-code-plan-global/k3')
    const declared = configOf(
      providerInjection({
        harness: 'opencode',
        connection: connection('ollama', {
          models: [],
          endpoint: { wireFormat: 'openai-chat', baseUrl: 'http://127.0.0.1:11434/v1' }
        }),
        model: 'clave-ollama/llama'
      }).env
    ) as { model: string; providers: Record<string, { models: Record<string, unknown> }> }
    expect(declared.model).toBe('clave-ollama/llama')
    expect(Object.keys(declared.providers['clave-ollama'].models)).toEqual(['llama'])
  })
  it('opencodeModelRef and opencodeConfiguredModel read the form OpenCode lists', () => {
    expect(opencodeModelRef('deepseek', 'deepseek-chat')).toBe('deepseek/deepseek-chat')
    expect(opencodeModelRef('deepseek', 'deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat')
    const env = providerInjection({
      harness: 'opencode',
      connection: connection('deepseek'),
      model: 'deepseek-chat'
    }).env
    expect(opencodeConfiguredModel(env)).toBe('deepseek/deepseek-chat')
    expect(
      opencodeConfiguredModel(
        providerInjection({ harness: 'opencode', connection: connection('deepseek') }).env
      )
    ).toBeUndefined()
    expect(opencodeConfiguredModel(undefined)).toBeUndefined()
    expect(opencodeConfiguredModel({ OPENCODE_CONFIG_CONTENT: 'not json' })).toBeUndefined()
  })
})
