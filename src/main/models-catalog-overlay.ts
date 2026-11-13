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
