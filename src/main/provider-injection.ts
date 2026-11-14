import type { CatalogModel } from './models-catalog'
import {
  providerCompany,
  type ProviderCompanyId,
  type ProviderWireFormat
} from '@clave/contract/settings/provider-catalogue'
import { CLAVE_CONNECTION_KEY_ENV, PROVIDER_ROAD_BY_ID } from './models-catalog-overlay'
import { CLAVE_PROVIDER_PREFIX } from '../shared/provider-prefix'

/**
 * How a stored provider connection reaches a Pi or an OpenCode tab's process
 * (PRDCT-4496). Pure. The rule: the connection a tab names is the credential
 * its process uses: its value rides in the environment under one name, and
 * the harness is told to read that name, never the value. OpenCode 2.3.0: a
 * `--standalone` TUI reads the tab's environment, `OPENCODE_CONFIG_CONTENT`
 * outranks its stored credential, and the `providers`/`package`/`settings`
 * shape lists the model (checked with `opencode models`); `opencode acp`, the
 * chat's agent, runs its own private server on that same environment, never
 * the background service, and its model call carries the tab's value (checked
 * against a stand-in endpoint, with the service running and with OpenCode's
 * state folders isolated from it). Pi 1.5.2 reads
 * `models.json` (`"$VAR"`) from its agent directory only, after auth.json:
 * hence a directory of the connection's own (provider-injection-pi-dir.ts).
 */

export interface ConnectionForSpawn {
  id: string
  label: string
  company: ProviderCompanyId
  /** The stored connection's endpoint a provider Clave declares is pointed
   *  at (lane B's `endpoints`, one chosen by the wiring); null when it has
   *  none. A road the harness ships reads its own. */
  endpoint: { wireFormat: ProviderWireFormat; baseUrl: string } | null
  /** What the provider issued, opened by the caller at spawn; null for Ollama. */
  value: string | null
  models?: string[]
}

/** The `api` of Pi's models.json for a wire format. */
const PI_API: Readonly<Record<ProviderWireFormat, string>> = {
  'openai-chat': 'openai-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages'
}

/** The AI SDK package OpenCode loads for a wire format. */
const OPENCODE_PACKAGE: Readonly<Record<ProviderWireFormat, string>> = {
  'anthropic-messages': '@ai-sdk/anthropic',
  'openai-responses': '@ai-sdk/openai',
  'openai-chat': '@ai-sdk/openai-compatible'
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

/** A model as OpenCode names it, `provider/model`. A model already in that
 *  form for this provider is kept as it is: a restarted chat's model is the
 *  one the agent reported, `kimi-code-plan-global/k3`, never prefixed twice. */
export function opencodeModelRef(providerId: string, model: string): string {
  return model.startsWith(`${providerId}/`) ? model : `${providerId}/${model}`
}

/** The bare id of a model a harness may report as `provider/model`. */
export function bareModel(providerId: string, model: string | undefined): string | undefined {
  return model?.startsWith(`${providerId}/`) ? model.slice(providerId.length + 1) : model
}

/** The provider a Pi or OpenCode tab on a connection of this company names
 *  its models under: the harness's own provider when it ships one (Pi's
 *  `kimi-coding`, OpenCode's `kimi-code-plan-global`), else the `clave-…` one
 *  Clave declares. Undefined for a company Clave does not know. */
export function connectionModelProvider(
  company: ProviderCompanyId,
  harness: 'pi' | 'opencode'
): string | undefined {
  const roads = PROVIDER_ROAD_BY_ID[company]
  if (!roads) return undefined
  return roads[harness]?.provider ?? `${CLAVE_PROVIDER_PREFIX}${roads.id}`
}

/** The model a chat's tab keeps on its record (PRDCT-4427). On a connection
 *  (`provider` is the one the tab's harness names its models under), the
 *  bare id, since the connection already says the provider and the launcher,
 *  `clave_launch_options` and `clave_list` name a model that way; a model of
 *  any other provider, or a tab on no connection (`provider` undefined),
 *  keeps the reported form, `provider/model` included. */
export function recordedChatModel(provider: string | undefined, model: string): string {
  return (provider && bareModel(provider, model)) || model
}

/** The model an OpenCode process is configured to start on, read off the
 *  configuration in its environment: what `opencode acp` opens its session
 *  on (checked on 2.3.0). Undefined when the configuration names none. */
export function opencodeConfiguredModel(
  env: Record<string, string> | undefined
): string | undefined {
  const content = env?.[OPENCODE_CONFIG_ENV]
  if (!content) return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    const model =
      parsed && typeof parsed === 'object' ? (parsed as { model?: unknown }).model : undefined
    return typeof model === 'string' && model ? model : undefined
  } catch {
    return undefined
  }
}

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
  const roads = PROVIDER_ROAD_BY_ID[connection.company]
  if (!roads) throw new Error('The connection names a provider Clave does not know.')
  const road = roads[harness]

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
    // `enabled_providers` keeps OpenCode on the connection: without it, a
    // launch that names no model starts on OpenCode's own free models and its
    // picker offers every other provider it knows (checked on 2.3.0).
    const config: Record<string, unknown> = {
      providers: { [road.provider]: { settings: { apiKey: `{env:${road.env}}` } } },
      enabled_providers: [road.provider]
    }
    if (model) config.model = opencodeModelRef(road.provider, model)
    env[OPENCODE_CONFIG_ENV] = JSON.stringify(config)
    return { env, opencodeStandalone: true }
  }

  // No provider of the harness's own: Clave declares one, its key read from
  // Clave's connection variable.
  const providerId = `${CLAVE_PROVIDER_PREFIX}${roads.id}`
  const { endpoint } = connection
  if (!endpoint) throw new Error('The connection has no endpoint.')
  const name = providerCompany(connection.company).name
  const models = declaredModels(connection, input.catalogModels, bareModel(providerId, model))
  const env: Record<string, string> = { [CLAVE_CONNECTION_KEY_ENV]: connection.value ?? NO_KEY }
  if (harness === 'pi') {
    return {
      env,
      piProvider: providerId,
      piEntry: {
        providerId,
        entry: {
          name,
          baseUrl: endpoint.baseUrl,
          api: PI_API[endpoint.wireFormat],
          apiKey: `$${CLAVE_CONNECTION_KEY_ENV}`,
          models
        }
      }
    }
  }
  const config: Record<string, unknown> = {
    providers: {
      [providerId]: {
        name,
        package: OPENCODE_PACKAGE[endpoint.wireFormat],
        settings: { baseURL: endpoint.baseUrl, apiKey: `{env:${CLAVE_CONNECTION_KEY_ENV}}` },
        models: Object.fromEntries(models.map((m) => [m.id, { name: m.name }]))
      }
    },
    enabled_providers: [providerId]
  }
  if (model) config.model = opencodeModelRef(providerId, model)
  env[OPENCODE_CONFIG_ENV] = JSON.stringify(config)
  return { env, opencodeStandalone: true }
}
