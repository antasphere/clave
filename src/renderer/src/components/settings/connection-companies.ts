import {
  PROVIDER_COMPANIES,
  type ProviderCompanyId
} from '@clave/contract/settings/provider-catalogue'
import { ClaudeLogo, CodexLogo } from '../icons/cli-logos'
import { DEFAULT_CLAUDE_PROFILE_ID, useClaudeProfileStore } from '../../store/claude-profile-store'
import { DEFAULT_CODEX_ACCOUNT_ID, useCodexAccountStore } from '../../store/codex-account-store'
import { useAccountLoginStore } from '../../store/account-login-store'

/**
 * The companies a person connects on Settings → Connections (PRDCT-4424): who
 * pays for what a harness runs. Each one is an account pool of ADR 0002
 * (`claude`, `codex`); the harness that runs on it is named in the hint. The
 * Connect chooser lists them in this order.
 */
export interface ConnectionCompany {
  id: 'anthropic' | 'openai'
  name: string
  /** The account pool its connections belong to. */
  pool: 'claude' | 'codex'
  Logo: (p: { className?: string }) => React.JSX.Element
  /** Which harness runs on it, in one sentence. */
  hint: string
}

export const CONNECTION_COMPANIES: readonly ConnectionCompany[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    pool: 'claude',
    Logo: ClaudeLogo,
    hint: 'Claude Code runs on it.'
  },
  { id: 'openai', name: 'OpenAI', pool: 'codex', Logo: CodexLogo, hint: 'Codex runs on it.' }
]

export const CONNECTION_COMPANY_BY_POOL: Readonly<Record<'claude' | 'codex', ConnectionCompany>> = {
  claude: CONNECTION_COMPANIES[0],
  codex: CONNECTION_COMPANIES[1]
}

/** A name no connection of the pool carries yet: "Anthropic", then
 *  "Anthropic 2", "Anthropic 3"… */
export function nextConnectionLabel(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((label) => label.trim().toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const label = `${base} ${n}`
    if (!used.has(label.toLowerCase())) return label
  }
}

// ── Lane B (harness wave): provider connections (PRDCT-4426) ──

/** A provider of the Connect chooser: a company of the catalogue, Ollama or
 *  another provider, connected with a key stored once. */
export interface ProviderConnectItem {
  id: ProviderCompanyId
  name: string
  /** What the person brings, in one sentence. */
  hint: string
}

const PROVIDER_HINTS: Readonly<Record<ProviderCompanyId, string>> = {
  moonshot: 'Kimi Code key.',
  zai: 'GLM Coding Plan key.',
  mistral: 'API key, pay per use.',
  deepseek: 'API key, pay per use.',
  minimax: 'Coding Plan key.',
  alibaba: 'Coding Plan key.',
  openrouter: 'One key for many models.',
  'vercel-ai-gateway': 'One key for many models.',
  ollama: 'Local models, no key.',
  generic: 'A base URL, a wire format and a key.'
}

/** The providers under Anthropic and OpenAI in the chooser, in catalogue order. */
export const PROVIDER_CONNECT_ITEMS: readonly ProviderConnectItem[] = PROVIDER_COMPANIES.map(
  (company) => ({ id: company.id, name: company.name, hint: PROVIDER_HINTS[company.id] })
)

export function providerConnectItem(id: ProviderCompanyId): ProviderConnectItem {
  const found = PROVIDER_CONNECT_ITEMS.find((item) => item.id === id)
  if (!found) throw new Error(`Unknown provider company: ${String(id)}`)
  return found
}

/** A label no connection of that provider carries yet: "Moonshot", then
 *  "Moonshot 2"… */
export function nextProviderLabel(name: string, taken: readonly string[]): string {
  return nextConnectionLabel(name, taken)
}

/**
 * Connect Anthropic (Settings → Connections' Connect chooser): the existing
 * browser login, on a connection made for it. A connection left without a
 * credential by an earlier attempt is taken up again, never doubled. Returns
 * the connection's id, or null when none could be made.
 */
export async function connectAnthropic(): Promise<string | null> {
  const { profiles, addProfile } = useClaudeProfileStore.getState()
  const base = CONNECTION_COMPANY_BY_POOL.claude.name
  const left = profiles.find(
    (p) => p.id !== DEFAULT_CLAUDE_PROFILE_ID && !p.hasToken && p.label.startsWith(base)
  )
  const target =
    left ??
    (await addProfile(
      nextConnectionLabel(
        base,
        profiles.map((p) => p.label)
      )
    ))
  if (!target) return null
  void useAccountLoginStore.getState().start('claude', target.id)
  return target.id
}

/**
 * Connect OpenAI (Settings → Connections' Connect chooser): the existing
 * `codex login` in the browser. The Mac's own `~/.codex` is signed in first
 * when it has no credential (a plain `codex` in a terminal works after it
 * too); otherwise a new connection is made for it. Returns its id, or null.
 */
export async function connectOpenAI(): Promise<string | null> {
  const { accounts, addAccount } = useCodexAccountStore.getState()
  const machine = accounts.find((a) => a.id === DEFAULT_CODEX_ACCOUNT_ID)
  const target =
    machine && !machine.hasCredential
      ? machine
      : await addAccount(
          nextConnectionLabel(
            CONNECTION_COMPANY_BY_POOL.codex.name,
            accounts.map((a) => a.label)
          ),
          'chatgpt'
        )
  if (!target) return null
  void useAccountLoginStore.getState().start('codex', target.id)
  return target.id
}
