/**
 * Settings domain: provider connections (PRDCT-4426). A provider connection
 * is a key stored once by Clave for a company's coding plan or API (Moonshot,
 * Z.ai, Mistral, …), a local Ollama, or a generic endpoint; it is sealed
 * behind the machine's secret port and listed as a card in Settings →
 * Connections, on the Mac and on a Clave server. The open harnesses (Pi,
 * OpenCode) run on it through the wire formats its endpoints speak.
 *
 * `src/main/provider-connections.ts` is the manager; the catalogue below is
 * plain data the renderer, main and the server all read from here.
 *
 * NO SCHEMA HERE MAY CARRY A SECRET. A provider key travels in one direction
 * only, client to server, in one payload, `SetProviderConnectionKey`. No
 * event, no query result and no other command success carries it: a
 * connection says `hasKey`.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { RefusedOrUnavailable } from './failures'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The wire format an endpoint speaks. */
export const ProviderWireFormat = Schema.Literal(
  'anthropic-messages',
  'openai-chat',
  'openai-responses'
)
export type ProviderWireFormat = typeof ProviderWireFormat.Type

export const PROVIDER_WIRE_FORMAT_NAMES: Readonly<Record<ProviderWireFormat, string>> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses'
}

/** The ten cards: nine companies of the catalogue and one generic endpoint. */
export const ProviderCompanyId = Schema.Literal(
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
)
export type ProviderCompanyId = typeof ProviderCompanyId.Type

export const ProviderEndpoint = Schema.Struct({
  wireFormat: ProviderWireFormat,
  baseUrl: Schema.String
})
export type ProviderEndpoint = typeof ProviderEndpoint.Type

/** A stored provider connection, as every client sees it. Never the key. */
export const ProviderConnectionView = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  company: ProviderCompanyId,
  /** The kind of connection in the shared definition of a connection (PRDCT-4493): a key, never a subscription signed in. */
  kind: Schema.Literal('key'),
  /** The pool this connection belongs to: the company's id. */
  pool: ProviderCompanyId,
  endpoints: Schema.Array(ProviderEndpoint),
  /** False for Ollama, which takes no key. */
  needsKey: Schema.Boolean,
  hasKey: Schema.Boolean,
  keySetAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number
})
export type ProviderConnectionView = typeof ProviderConnectionView.Type

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export interface ProviderCompany {
  readonly id: ProviderCompanyId
  /** As shown on the card. */
  readonly name: string
  /** The coding plan the key comes from, as the company names it, or null. */
  readonly plan: string | null
  readonly needsKey: boolean
  /** The add form asks for a base URL (Ollama: prefilled with the default; generic: empty). */
  readonly takesBaseUrl: boolean
  /** The add form asks for the wire format (generic only). */
  readonly takesWireFormat: boolean
  /** Where the person gets a key, or null. */
  readonly keyUrl: string | null
  /** The catalogue endpoints; empty for generic. */
  readonly endpoints: readonly ProviderEndpoint[]
}

/** A company whose endpoints come from the catalogue and whose card takes a label and a key. */
const company = (
  id: ProviderCompanyId,
  name: string,
  plan: string | null,
  keyUrl: string | null,
  endpoints: readonly ProviderEndpoint[]
): ProviderCompany => ({
  id,
  name,
  plan,
  needsKey: true,
  takesBaseUrl: false,
  takesWireFormat: false,
  keyUrl,
  endpoints
})

export const PROVIDER_COMPANIES: readonly ProviderCompany[] = [
  company('moonshot', 'Moonshot', 'Kimi Code', 'https://www.kimi.com/code', [
    { wireFormat: 'openai-chat', baseUrl: 'https://api.kimi.ai/coding/v1' },
    { wireFormat: 'anthropic-messages', baseUrl: 'https://api.kimi.ai/coding/' }
  ]),
  company('zai', 'Z.ai', 'GLM Coding Plan', 'https://z.ai/manage-apikey/apikey-list', [
    { wireFormat: 'openai-chat', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
    { wireFormat: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic' }
  ]),
  company('mistral', 'Mistral', null, 'https://console.mistral.ai/api-keys', [
    { wireFormat: 'openai-chat', baseUrl: 'https://api.mistral.ai/v1' }
  ]),
  company('deepseek', 'DeepSeek', null, 'https://platform.deepseek.com/api_keys', [
    { wireFormat: 'openai-chat', baseUrl: 'https://api.deepseek.com' },
    { wireFormat: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic' }
  ]),
  company(
    'minimax',
    'MiniMax',
    'Coding Plan',
    'https://platform.minimax.io/user-center/basic-information/interface-key',
    [
      { wireFormat: 'openai-chat', baseUrl: 'https://api.minimax.io/v1' },
      { wireFormat: 'anthropic-messages', baseUrl: 'https://api.minimax.io/anthropic' }
    ]
  ),
  company(
    'alibaba',
    'Alibaba',
    'Coding Plan',
    'https://modelstudio.console.alibabacloud.com/?tab=model#/api-key',
    [{ wireFormat: 'openai-chat', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1' }]
  ),
  company('openrouter', 'OpenRouter', null, 'https://openrouter.ai/settings/keys', [
    { wireFormat: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1' }
  ]),
  company('vercel-ai-gateway', 'Vercel AI Gateway', null, 'https://vercel.com/ai-gateway', [
    { wireFormat: 'openai-chat', baseUrl: 'https://ai-gateway.vercel.sh/v1' }
  ]),
  {
    ...company('ollama', 'Ollama', null, null, [
      { wireFormat: 'openai-chat', baseUrl: 'http://localhost:11434/v1' }
    ]),
    needsKey: false,
    takesBaseUrl: true
  },
  {
    ...company('generic', 'Another provider', null, null, []),
    takesBaseUrl: true,
    takesWireFormat: true
  }
]

/** The catalogue row of a company. Throws on an unknown id: a programming error. */
export function providerCompany(id: ProviderCompanyId): ProviderCompany {
  const found = PROVIDER_COMPANIES.find((c) => c.id === id)
  if (!found) throw new Error(`Unknown provider company: ${String(id)}`)
  return found
}

/**
 * Whether a connection serves a harness: one of its endpoints speaks a wire
 * format the harness speaks. The caller passes the harness's `wireFormats`
 * from the harness table.
 */
export function connectionServes(
  connection: Pick<ProviderConnectionView, 'endpoints'>,
  formats: readonly ProviderWireFormat[]
): boolean {
  return connection.endpoints.some((e) => formats.includes(e.wireFormat))
}

// ---------------------------------------------------------------------------
// Queries and commands
// ---------------------------------------------------------------------------

/** Every provider connection of the machine, never a key. */
export const ListProviderConnections = Query.define('ListProviderConnections', {
  payload: Schema.Struct({}),
  success: Schema.Array(ProviderConnectionView)
})

/** A new card: a company of the catalogue, Ollama at a base URL, or a generic endpoint. */
export const AddProviderConnection = Command.define('AddProviderConnection', {
  payload: Schema.Struct({
    company: ProviderCompanyId,
    label: Schema.optional(Schema.String),
    baseUrl: Schema.optional(Schema.String),
    wireFormat: Schema.optional(ProviderWireFormat)
  }),
  success: ProviderConnectionView,
  failure: RefusedOrUnavailable
})

export const RenameProviderConnection = Command.define('RenameProviderConnection', {
  payload: Schema.Struct({ id: Schema.String, label: Schema.String }),
  success: ProviderConnectionView,
  failure: RefusedOrUnavailable
})

/** Removing a connection forgets its key with it. */
export const RemoveProviderConnection = Command.define('RemoveProviderConnection', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Boolean,
  failure: RefusedOrUnavailable
})

/** The one payload a provider key travels in, redacted; the answer says `hasKey`. */
export const SetProviderConnectionKey = Command.define('SetProviderConnectionKey', {
  payload: Schema.Struct({ id: Schema.String, apiKey: Schema.Redacted(Schema.String) }),
  success: ProviderConnectionView,
  failure: RefusedOrUnavailable
})

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The whole list after any change, never a key. */
export const ProviderConnectionsChanged = Schema.TaggedStruct('accounts.providers_changed', {
  connections: Schema.Array(ProviderConnectionView)
})
