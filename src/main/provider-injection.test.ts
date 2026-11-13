import { describe, it, expect } from 'vitest'
import { providerInjection, type ConnectionForSpawn } from './provider-injection'
import {
  CLAVE_CONNECTION_KEY_ENV,
  PROVIDER_COMPANIES,
  PROVIDER_KEY_ENV_VARS,
  type ProviderCompanyId
} from './models-catalog-overlay'
import type { CatalogModel } from './models-catalog'

/**
 * The rule (PRDCT-4496): the connection a tab names is the credential its
 * process uses. Its value rides in the environment under exactly one name,
 * and what the harness is told (OpenCode's inline config, Pi's models.json
 * entry) names that variable and never holds the value.
 */

const VALUE = 'made-up-value-4496'

function connection(
  company: ProviderCompanyId,
  extra: Partial<ConnectionForSpawn> = {}
): ConnectionForSpawn {
  return { id: `conn-${company}`, label: company, company, value: VALUE, ...extra }
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
          baseUrl: company.baseUrl ?? 'http://127.0.0.1:9/v1',
          models: ['m-one']
        })
        const out = providerInjection({ harness, connection: conn, model: 'm-one' })
        const road = company[harness]
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
        } else {
          expect(out.opencodeStandalone).toBe(true)
          expect(out.env.OPENCODE_CONFIG_CONTENT).not.toContain(VALUE)
          const config = configOf(out.env) as {
            providers: Record<string, { settings: { apiKey: string } }>
            model: string
          }
          expect(Object.keys(config.providers)).toEqual([providerId])
          expect(config.providers[providerId].settings.apiKey).toBe(`{env:${keyName}}`)
          expect(config.model).toBe(`${providerId}/m-one`)
          expect(out.piProvider).toBeUndefined()
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
      providers: { 'zai-coding-plan': { settings: { apiKey: '{env:ZHIPU_API_KEY}' } } }
    })
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
        name: 'Alibaba Coding Plan',
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

  it('Ollama with no value: the word a local server ignores', () => {
    const out = providerInjection({
      harness: 'opencode',
      connection: connection('ollama', { value: null, models: ['llama'] }),
      model: 'llama'
    })
    expect(out.env[CLAVE_CONNECTION_KEY_ENV]).toBe('ollama')
    const config = configOf(out.env)
    expect(config).toEqual({
      providers: {
        'clave-ollama': {
          name: 'Ollama',
          package: '@ai-sdk/openai-compatible',
          settings: {
            baseURL: 'http://127.0.0.1:11434/v1',
            apiKey: '{env:CLAVE_CONNECTION_API_KEY}'
          },
          models: { llama: { name: 'llama' } }
        }
      },
      model: 'clave-ollama/llama'
    })
  })

  it('a custom card on the Anthropic wire uses its own base URL and package', () => {
    const conn = connection('custom', {
      baseUrl: 'https://example.invalid/anthropic',
      wire: 'anthropic-messages'
    })
    const oc = configOf(providerInjection({ harness: 'opencode', connection: conn }).env) as {
      providers: Record<string, { package: string; settings: { baseURL: string } }>
    }
    expect(oc.providers['clave-custom'].package).toBe('@ai-sdk/anthropic')
    expect(oc.providers['clave-custom'].settings.baseURL).toBe('https://example.invalid/anthropic')
    const pi = providerInjection({ harness: 'pi', connection: conn })
    expect(pi.piEntry?.entry.api).toBe('anthropic-messages')
    expect(pi.piEntry?.entry.baseUrl).toBe('https://example.invalid/anthropic')
  })

  it('a custom card without a base URL is refused', () => {
    for (const harness of ['pi', 'opencode'] as const)
      expect(() => providerInjection({ harness, connection: connection('custom') })).toThrow(
        'The connection has no base URL.'
      )
  })
})
