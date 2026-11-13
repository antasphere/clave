import type { CatalogModel } from './models-catalog'
import {
  CLAVE_CONNECTION_KEY_ENV,
  PROVIDER_COMPANY_BY_ID,
  type ProviderCompanyId
} from './models-catalog-overlay'

/**
 * How a stored provider connection reaches a Pi or an OpenCode tab's process
 * (PRDCT-4496). Pure. The rule: the connection a tab names is the credential
 * its process uses: its value rides in the environment under one name, and
 * the harness is told to read that name, never the value. OpenCode 2.3.0: a
 * `--standalone` TUI reads the tab's environment, `OPENCODE_CONFIG_CONTENT`
 * outranks its stored credential, and the `providers`/`package`/`settings`
 * shape lists the model (checked with `opencode models`). Pi 1.5.2 reads
 * `models.json` (`"$VAR"`) from its agent directory only, after auth.json:
 * hence a directory of the connection's own (provider-injection-pi-dir.ts).
 */

export interface ConnectionForSpawn {
  id: string
  label: string
  company: ProviderCompanyId
  /** The card's own, for `ollama` and `custom`: wins over the company row. */
  baseUrl?: string | null
  wire?: 'openai-completions' | 'anthropic-messages' | null
  /** What the provider issued, opened by the caller at spawn; null for Ollama. */
  value: string | null
  models?: string[]
}

export interface PiProviderEntry {
  name: string
  baseUrl: string
  api: string
  apiKey: string
  models: { id: string; name: string }[]
}

export interface ProviderInjection {
  env: Record<string, string>
  piProvider?: string
  /** The entry Clave writes into the connection's Pi `models.json`: the key
   *  alone over a provider Pi ships, a full provider otherwise. */
  piEntry?: { providerId: string; entry: Partial<PiProviderEntry> & { apiKey: string } }
  opencodeStandalone?: boolean
}

/** What a local OpenAI-compatible server is handed when there is no key: it
 *  accepts and ignores it, and both harnesses refuse a provider without one. */
const NO_KEY = 'ollama'

export const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT'

function declaredModels(
  connection: ConnectionForSpawn,
  catalogModels: CatalogModel[] | undefined,
  model: string | undefined
): { id: string; name: string }[] {
  const out = new Map<string, { id: string; name: string }>()
  for (const m of catalogModels ?? [])
    if (m.status !== 'deprecated' && !out.has(m.id))
      out.set(m.id, { id: m.id, name: m.name || m.id })
  for (const id of [...(connection.models ?? []), ...(model ? [model] : [])])
    if (id && !out.has(id)) out.set(id, { id, name: id })
  return [...out.values()]
}

export function providerInjection(input: {
  harness: 'pi' | 'opencode'
  connection: ConnectionForSpawn | null
  model?: string
  catalogModels?: CatalogModel[]
}): ProviderInjection {
  const { harness, connection, model } = input
  if (!connection) {
    // Pi's model rides on its command line; OpenCode's TUI has no flag for it.
    if (harness === 'opencode' && model)
      return { env: { [OPENCODE_CONFIG_ENV]: JSON.stringify({ model }) }, opencodeStandalone: true }
    return { env: {} }
  }
  const company = PROVIDER_COMPANY_BY_ID[connection.company]
  if (!company) throw new Error('The connection names a provider Clave does not know.')
  const road = company[harness]

  if (road) {
    // A provider the harness ships: its own variable, and the harness told to
    // read it over whatever it has stored for that provider.
    const env: Record<string, string> = {}
    if (connection.value !== null) env[road.env] = connection.value
    if (harness === 'pi')
      return {
        env,
        piProvider: road.provider,
        piEntry: { providerId: road.provider, entry: { apiKey: `$${road.env}` } }
      }
    const config: Record<string, unknown> = {
      providers: { [road.provider]: { settings: { apiKey: `{env:${road.env}}` } } }
    }
    if (model) config.model = `${road.provider}/${model}`
    env[OPENCODE_CONFIG_ENV] = JSON.stringify(config)
    return { env, opencodeStandalone: true }
  }

  // No provider of the harness's own: Clave declares one, its key read from
  // Clave's connection variable.
  const providerId = `clave-${company.id}`
  const baseUrl = connection.baseUrl ?? company.baseUrl
  if (!baseUrl) throw new Error('The connection has no base URL.')
  const wire = connection.wire ?? company.wire ?? 'openai-completions'
  const models = declaredModels(connection, input.catalogModels, model)
  const env: Record<string, string> = { [CLAVE_CONNECTION_KEY_ENV]: connection.value ?? NO_KEY }
  if (harness === 'pi') {
    return {
      env,
      piProvider: providerId,
      piEntry: {
        providerId,
        entry: {
          name: company.name,
          baseUrl,
          api: wire,
          apiKey: `$${CLAVE_CONNECTION_KEY_ENV}`,
          models
        }
      }
    }
  }
  const config: Record<string, unknown> = {
    providers: {
      [providerId]: {
        name: company.name,
        package: wire === 'anthropic-messages' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
        settings: { baseURL: baseUrl, apiKey: `{env:${CLAVE_CONNECTION_KEY_ENV}}` },
        models: Object.fromEntries(models.map((m) => [m.id, { name: m.name }]))
      }
    }
  }
  if (model) config.model = `${providerId}/${model}`
  env[OPENCODE_CONFIG_ENV] = JSON.stringify(config)
  return { env, opencodeStandalone: true }
}
