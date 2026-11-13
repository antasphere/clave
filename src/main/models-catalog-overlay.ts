/**
 * The overlay on the models.dev catalogue (PRDCT-4496): for each provider
 * company Clave stores a key for, what models.dev does not carry — the
 * endpoint, its wire, and the provider id and key variable each open harness
 * uses. Read on 13 November 2026 from:
 *   - `pi --help` (Pi 1.5.2): Pi's provider ids and the variables it reads;
 *   - models.dev api.json: the catalogue provider ids and their `env` fields;
 *   - OpenCode 2.3.0: OpenCode's provider ids and the variables it reads.
 * A null road means the harness ships no provider for that company: the key
 * then reaches it as `CLAVE_CONNECTION_API_KEY` on a connection Clave declares.
 */

export type ProviderCompanyId =
  | 'moonshot'
  | 'zai'
  | 'deepseek'
  | 'minimax'
  | 'alibaba'
  | 'mistral'
  | 'openrouter'
  | 'vercel'
  | 'ollama'
  | 'custom'

/** A harness's own provider id, and the variable it reads the key from. */
export interface HarnessProviderRoad {
  provider: string
  env: string
}

export interface ProviderCompany {
  id: ProviderCompanyId
  name: string
  /** The models.dev provider whose models are listed; null when none. */
  catalog: string | null
  baseUrl: string | null
  wire: 'openai-completions' | 'anthropic-messages' | null
  pi: HarnessProviderRoad | null
  opencode: HarnessProviderRoad | null
  usage: 'documented' | 'undocumented' | 'none'
}

/** The variable a connection with no harness-shipped provider is read from. */
export const CLAVE_CONNECTION_KEY_ENV = 'CLAVE_CONNECTION_API_KEY'

export const PROVIDER_COMPANIES: readonly ProviderCompany[] = [
  {
    id: 'moonshot',
    name: 'Kimi For Coding',
    catalog: 'kimi-code-plan-global',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    wire: 'openai-completions',
    pi: { provider: 'kimi-coding', env: 'KIMI_API_KEY' },
    opencode: { provider: 'kimi-code-plan-global', env: 'KIMI_API_KEY' },
    usage: 'undocumented'
  },
  {
    id: 'zai',
    name: 'Z.ai GLM Coding Plan',
    catalog: 'zai-coding-plan',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    wire: 'openai-completions',
    pi: { provider: 'zai', env: 'ZAI_API_KEY' },
    opencode: { provider: 'zai-coding-plan', env: 'ZHIPU_API_KEY' },
    usage: 'undocumented'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    catalog: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    wire: 'openai-completions',
    pi: { provider: 'deepseek', env: 'DEEPSEEK_API_KEY' },
    opencode: { provider: 'deepseek', env: 'DEEPSEEK_API_KEY' },
    usage: 'documented'
  },
  {
    id: 'minimax',
    name: 'MiniMax Coding Plan',
    catalog: 'minimax-coding-plan',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    wire: 'anthropic-messages',
    pi: { provider: 'minimax', env: 'MINIMAX_API_KEY' },
    opencode: { provider: 'minimax-coding-plan', env: 'MINIMAX_API_KEY' },
    usage: 'documented'
  },
  {
    id: 'alibaba',
    name: 'Alibaba Coding Plan',
    catalog: 'alibaba-coding-plan',
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
    wire: 'openai-completions',
    // Pi ships no provider for it.
    pi: null,
    opencode: { provider: 'alibaba-coding-plan', env: 'ALIBABA_CODING_PLAN_API_KEY' },
    usage: 'none'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    catalog: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    wire: 'openai-completions',
    pi: { provider: 'mistral', env: 'MISTRAL_API_KEY' },
    opencode: { provider: 'mistral', env: 'MISTRAL_API_KEY' },
    usage: 'none'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    catalog: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    wire: 'openai-completions',
    pi: { provider: 'openrouter', env: 'OPENROUTER_API_KEY' },
    opencode: { provider: 'openrouter', env: 'OPENROUTER_API_KEY' },
    usage: 'documented'
  },
  {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    catalog: 'vercel',
    baseUrl: null,
    wire: null,
    pi: { provider: 'vercel-ai-gateway', env: 'AI_GATEWAY_API_KEY' },
    opencode: { provider: 'vercel', env: 'AI_GATEWAY_API_KEY' },
    usage: 'documented'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    catalog: null,
    baseUrl: 'http://127.0.0.1:11434/v1',
    wire: 'openai-completions',
    pi: null,
    opencode: null,
    usage: 'none'
  },
  {
    id: 'custom',
    name: 'Another provider',
    catalog: null,
    baseUrl: null,
    wire: null,
    pi: null,
    opencode: null,
    usage: 'none'
  }
]

export const PROVIDER_COMPANY_BY_ID = Object.fromEntries(
  PROVIDER_COMPANIES.map((company) => [company.id, company])
) as Record<ProviderCompanyId, ProviderCompany>

/** The variable a harness reads this company's key from: its own road's, or
 *  Clave's connection variable when the harness ships no provider for it. */
export function envForHarness(company: ProviderCompanyId, harness: 'pi' | 'opencode'): string {
  return PROVIDER_COMPANY_BY_ID[company][harness]?.env ?? CLAVE_CONNECTION_KEY_ENV
}

/** Every key variable a harness may read, sorted and distinct: the names a
 *  key can travel under (the list `TMUX_SESSION_ENV_VARS` will extend). */
export const PROVIDER_KEY_ENV_VARS: readonly string[] = [
  ...new Set([
    CLAVE_CONNECTION_KEY_ENV,
    ...PROVIDER_COMPANIES.flatMap((company) =>
      [company.pi, company.opencode].flatMap((road) => (road ? [road.env] : []))
    )
  ])
].sort()
