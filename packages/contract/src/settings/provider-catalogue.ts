/**
 * The provider catalogue (PRDCT-4426), plain data with no import at all: the
 * wire formats, the ten cards of Settings → Connections and their endpoints.
 * The renderer and `src/shared` import it by value through
 * `@clave/contract/settings/provider-catalogue`; the Effect schemas built on
 * it live in `./connections`, which re-exports everything here.
 */

/** The wire format an endpoint speaks. */
export const PROVIDER_WIRE_FORMATS = [
  'anthropic-messages',
  'openai-chat',
  'openai-responses'
] as const
export type ProviderWireFormat = (typeof PROVIDER_WIRE_FORMATS)[number]

export const PROVIDER_WIRE_FORMAT_NAMES: Readonly<Record<ProviderWireFormat, string>> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses'
}

/** The ten cards: nine companies of the catalogue and one generic endpoint. */
export const PROVIDER_COMPANY_IDS = [
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
] as const
export type ProviderCompanyId = (typeof PROVIDER_COMPANY_IDS)[number]

export interface ProviderEndpoint {
  readonly wireFormat: ProviderWireFormat
  readonly baseUrl: string
}

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
  connection: { readonly endpoints: readonly ProviderEndpoint[] },
  formats: readonly ProviderWireFormat[]
): boolean {
  return connection.endpoints.some((e) => formats.includes(e.wireFormat))
}
