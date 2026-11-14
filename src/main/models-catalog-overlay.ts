/**
 * The overlay on the models.dev catalogue (PRDCT-4496): for each provider
 * company Clave stores a key for (lane B's ids, `@clave/contract/settings/
 * provider-catalogue`), what neither models.dev nor that catalogue carries:
 * the models.dev provider whose models are listed, and the provider id and
 * key variable each open harness uses. The names and the endpoints are the
 * catalogue's; the usage road is `provider-usage.ts`'s. Read on 13 November
 * 2026 from:
 *   - `pi --help` (Pi 1.5.2): Pi's provider ids and the variables it reads;
 *   - models.dev api.json: the catalogue provider ids and their `env` fields;
 *   - OpenCode 2.3.0: OpenCode's provider ids and the variables it reads.
 * A null road means the harness ships no provider for that company: the key
 * then reaches it as `CLAVE_CONNECTION_API_KEY` on a connection Clave declares.
 */
import {
  PROVIDER_COMPANY_IDS,
  providerCompany,
  type ProviderCompanyId
} from '@clave/contract/settings/provider-catalogue'
import { CLAVE_PROVIDER_PREFIX } from '../shared/provider-prefix'

export type { ProviderCompanyId }

/** A harness's own provider id, and the variable it reads the key from. */
export interface HarnessProviderRoad {
  provider: string
  env: string
}

export interface ProviderRoad {
  id: ProviderCompanyId
  /** The models.dev provider whose models are listed; null when none. */
  catalog: string | null
  pi: HarnessProviderRoad | null
  opencode: HarnessProviderRoad | null
}

/** The variable a connection with no harness-shipped provider is read from. */
export const CLAVE_CONNECTION_KEY_ENV = 'CLAVE_CONNECTION_API_KEY'

export const PROVIDER_ROADS: readonly ProviderRoad[] = [
  {
    id: 'moonshot',
    catalog: 'kimi-code-plan-global',
    pi: { provider: 'kimi-coding', env: 'KIMI_API_KEY' },
    opencode: { provider: 'kimi-code-plan-global', env: 'KIMI_API_KEY' }
  },
  {
    id: 'zai',
    catalog: 'zai-coding-plan',
    pi: { provider: 'zai', env: 'ZAI_API_KEY' },
    opencode: { provider: 'zai-coding-plan', env: 'ZHIPU_API_KEY' }
  },
  {
    id: 'mistral',
    catalog: 'mistral',
    pi: { provider: 'mistral', env: 'MISTRAL_API_KEY' },
    opencode: { provider: 'mistral', env: 'MISTRAL_API_KEY' }
  },
  {
    id: 'deepseek',
    catalog: 'deepseek',
    pi: { provider: 'deepseek', env: 'DEEPSEEK_API_KEY' },
    opencode: { provider: 'deepseek', env: 'DEEPSEEK_API_KEY' }
  },
  {
    id: 'minimax',
    catalog: 'minimax-coding-plan',
    pi: { provider: 'minimax', env: 'MINIMAX_API_KEY' },
    opencode: { provider: 'minimax-coding-plan', env: 'MINIMAX_API_KEY' }
  },
  {
    id: 'alibaba',
    catalog: 'alibaba-coding-plan',
    // Pi ships no provider for it.
    pi: null,
    opencode: { provider: 'alibaba-coding-plan', env: 'ALIBABA_CODING_PLAN_API_KEY' }
  },
  {
    id: 'openrouter',
    catalog: 'openrouter',
    pi: { provider: 'openrouter', env: 'OPENROUTER_API_KEY' },
    opencode: { provider: 'openrouter', env: 'OPENROUTER_API_KEY' }
  },
  {
    id: 'vercel-ai-gateway',
    catalog: 'vercel',
    pi: { provider: 'vercel-ai-gateway', env: 'AI_GATEWAY_API_KEY' },
    opencode: { provider: 'vercel', env: 'AI_GATEWAY_API_KEY' }
  },
  { id: 'ollama', catalog: null, pi: null, opencode: null },
  { id: 'generic', catalog: null, pi: null, opencode: null }
]

export const PROVIDER_ROAD_BY_ID = Object.fromEntries(
  PROVIDER_ROADS.map((road) => [road.id, road])
) as Record<ProviderCompanyId, ProviderRoad>

/** What the launcher's model listing reads of each company
 *  (`ProviderCompanies` in `src/shared/launch-models.ts`): the catalogue's
 *  name, and the road's models.dev provider. */
export const PROVIDER_LISTING_FACTS: Readonly<
  Record<ProviderCompanyId, { name: string; catalog: string | null }>
> = Object.fromEntries(
  PROVIDER_COMPANY_IDS.map((id) => [
    id,
    { name: providerCompany(id).name, catalog: PROVIDER_ROAD_BY_ID[id].catalog }
  ])
) as Record<ProviderCompanyId, { name: string; catalog: string | null }>

/** The variable a harness reads this company's key from: its own road's, or
 *  Clave's connection variable when the harness ships no provider for it. */
export function envForHarness(company: ProviderCompanyId, harness: 'pi' | 'opencode'): string {
  return PROVIDER_ROAD_BY_ID[company][harness]?.env ?? CLAVE_CONNECTION_KEY_ENV
}

/** Pi's provider id for a company's connection: the one Pi ships, else the
 *  one Clave declares in the connection's own directory (`clave-<company>`). */
export function piProviderOf(company: ProviderCompanyId): string {
  return PROVIDER_ROAD_BY_ID[company].pi?.provider ?? `${CLAVE_PROVIDER_PREFIX}${company}`
}

/** Every key variable a harness may read, sorted and distinct: the names a
 *  key can travel under (the list `TMUX_SESSION_ENV_VARS` will extend). */
export const PROVIDER_KEY_ENV_VARS: readonly string[] = [
  ...new Set([
    CLAVE_CONNECTION_KEY_ENV,
    ...PROVIDER_ROADS.flatMap((road) =>
      [road.pi, road.opencode].flatMap((harness) => (harness ? [harness.env] : []))
    )
  ])
].sort()

/**
 * Every variable Pi 1.5.2 takes a provider's credential from, sorted and
 * distinct (PRDCT-4496): the key table of Pi's `docs/providers.md` ("Use an
 * API key from the environment"), Anthropic's tokens and identity
 * federation, Azure OpenAI's key, and what makes Amazon Bedrock and Google
 * Vertex AI list themselves (a profile, IAM keys, a bearer token, container
 * or web-identity credentials; a key, or a credentials file with a project
 * and a location), as Pi's own `env-api-keys.js` reads them. With one of
 * these in its environment Pi lists that provider and switches to it, then
 * spends that credential (checked on 1.5.2), and Pi has no setting or flag
 * that keeps a process to one provider (`enabledModels`/`--models` only
 * scope cycling; `set_model` takes any listed model). So a Pi process on a
 * stored connection starts without every one of them but the connection's
 * own (`piConnectionEnv`), and Clave's own variable is on the list too.
 */
export const PI_PROVIDER_CREDENTIAL_ENV_VARS: readonly string[] = [
  ...new Set([
    CLAVE_CONNECTION_KEY_ENV,
    // The single-key providers of Pi's table.
    'AI_GATEWAY_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANT_LING_API_KEY',
    'BASETEN_API_KEY',
    'CEREBRAS_API_KEY',
    'COPILOT_GITHUB_TOKEN',
    'DEEPSEEK_API_KEY',
    'FIREWORKS_API_KEY',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'HF_TOKEN',
    'KIMI_API_KEY',
    'META_API_KEY',
    'MINIMAX_API_KEY',
    'MINIMAX_CN_API_KEY',
    'MISTRAL_API_KEY',
    'MOONSHOT_API_KEY',
    'NVIDIA_API_KEY',
    'OPENAI_API_KEY',
    'OPENCODE_API_KEY',
    'OPENROUTER_API_KEY',
    'QWEN_TOKEN_PLAN_API_KEY',
    'QWEN_TOKEN_PLAN_CN_API_KEY',
    'RADIUS_API_KEY',
    'TOGETHER_API_KEY',
    'TYPESAFE_API_KEY',
    'XAI_API_KEY',
    'XIAOMI_API_KEY',
    'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
    'XIAOMI_TOKEN_PLAN_CN_API_KEY',
    'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
    'ZAI_API_KEY',
    'ZAI_CODING_CN_API_KEY',
    // Anthropic's tokens and its workload identity federation.
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_IDENTITY_TOKEN_FILE',
    // Azure OpenAI, Cloudflare (Workers AI and AI Gateway).
    'AZURE_OPENAI_API_KEY',
    'CLOUDFLARE_API_KEY',
    // Amazon Bedrock: any one of these lists it.
    'AWS_ACCESS_KEY_ID',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_PROFILE',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    // Google Vertex AI: its key, or a credentials file (the named one, or
    // gcloud's default one in the home) with a project and a location.
    'GCLOUD_PROJECT',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_API_KEY',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_CLOUD_PROJECT'
  ])
].sort()

/** The names of `PI_PROVIDER_CREDENTIAL_ENV_VARS` a Pi process on a stored
 *  connection must not have: every one the connection itself does not set
 *  (`own`, the connection's own variables). */
export function piForeignCredentialVars(own: Readonly<Record<string, string>>): string[] {
  return PI_PROVIDER_CREDENTIAL_ENV_VARS.filter(
    (name) => !Object.prototype.hasOwnProperty.call(own, name)
  )
}
