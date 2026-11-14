/**
 * What a card of Settings → Connections says (PRDCT-4552), as plain data: one
 * card shape for everything that pays for a tab, a Claude account, a Codex
 * account and a stored provider connection alike, and one for each provider
 * that can be connected. Pure, so every sentence a card can say is tested
 * without a window; the components only lay the words out.
 */
import {
  PROVIDER_COMPANIES,
  providerCompany,
  type ProviderCompany,
  type ProviderCompanyId,
  type ProviderEndpoint
} from '@clave/contract/settings/provider-catalogue'
import { HARNESSES, type HarnessId } from '../../../../shared/harness'

/** The tone of a card's state: working, nothing to do, or something to fix. */
export type CardTone = 'ok' | 'quiet' | 'attention'

export interface CardState {
  /** In plain words: "Signed in", "Key stored", "Needs a key"… */
  label: string
  tone: CardTone
}

/** Who a connection belongs to, by the company key the logos use. */
export type CardCompany = 'anthropic' | 'openai' | ProviderCompanyId

export interface CardFacts {
  company: CardCompany
  /** The company's name as the card heads it. */
  companyName: string
  /** What it is in two or three words: a subscription, a coding plan, pay per use, local. */
  what: string
  state: CardState
  /** The harnesses that run on it, in the harness table's order. */
  harnesses: HarnessId[]
}

// ── The harnesses ───────────────────────────────────────────────────────────

/** The harnesses a provider's endpoints serve: those speaking one of their
 *  wire formats. Another provider has no endpoint until it is made, and
 *  every wire format the form offers is spoken by the same harnesses. */
export function harnessesForEndpoints(endpoints: readonly ProviderEndpoint[] | null): HarnessId[] {
  return HARNESSES.filter((harness) =>
    endpoints === null
      ? harness.wireFormats.length > 0
      : endpoints.some((e) => harness.wireFormats.includes(e.wireFormat))
  ).map((harness) => harness.id)
}

// ── What it is ──────────────────────────────────────────────────────────────

/** A provider's kind in its own words: the coding plan's name, pay per use,
 *  many models behind one key, local, or an endpoint of the person's own. */
export function providerWhat(company: ProviderCompany): string {
  if (company.plan) return /plan$/i.test(company.plan) ? company.plan : `${company.plan} plan`
  switch (company.id) {
    case 'openrouter':
    case 'vercel-ai-gateway':
      return 'Many models, one key'
    case 'ollama':
      return 'Local models'
    case 'generic':
      return 'Your own endpoint'
    default:
      return 'Pay per use'
  }
}

// ── The cards of what is connected ──────────────────────────────────────────

export interface ClaudeCardInput {
  id: string
  hasToken: boolean
  tokenInvalid: boolean
  /** "expires in 12 months", "expired", or null (`describeTokenLife`). */
  tokenLife: string | null
  /** A connection carried over from the retired config-dir shape, not signed in again yet. */
  migrated: boolean
  /** The machine's own login (`~/.claude`), always there. */
  isDefault: boolean
}

export function claudeCardFacts(account: ClaudeCardInput): CardFacts {
  return {
    company: 'anthropic',
    companyName: 'Anthropic',
    what: 'Subscription',
    state: claudeState(account),
    harnesses: ['claude']
  }
}

function claudeState(account: ClaudeCardInput): CardState {
  if (account.isDefault) return { label: 'Machine login', tone: 'quiet' }
  if (account.tokenInvalid) return { label: 'Sign-in refused', tone: 'attention' }
  if (account.migrated || !account.hasToken) return { label: 'Needs sign-in', tone: 'attention' }
  if (account.tokenLife === 'expired') return { label: 'Sign-in expired', tone: 'attention' }
  return { label: 'Signed in', tone: 'ok' }
}

/** A subscription's usage line: its headroom, or why there is none. */
export function accountUsageText(line: string | null, read: boolean): string | null {
  if (line) return line
  return read ? 'No limits reported yet' : null
}

/** How long a Claude account's sign-in lasts, for its card's facts; null
 *  for the machine login or an account with no token. */
export function claudeTokenLine(tokenLife: string | null): string | null {
  return tokenLife ? `Token, ${tokenLife}` : null
}

export interface CodexCardInput {
  id: string
  kind: 'chatgpt' | 'apiKey'
  hasCredential: boolean
  isDefault: boolean
}

export function codexCardFacts(account: CodexCardInput): CardFacts {
  return {
    company: 'openai',
    companyName: 'OpenAI',
    what: account.kind === 'apiKey' ? 'Pay per use' : 'Subscription',
    state: codexState(account),
    harnesses: ['codex']
  }
}

function codexState(account: CodexCardInput): CardState {
  if (account.kind === 'apiKey')
    return account.hasCredential
      ? { label: 'Key stored', tone: 'ok' }
      : { label: 'Needs a key', tone: 'attention' }
  if (account.isDefault)
    return account.hasCredential
      ? { label: 'Machine login', tone: 'quiet' }
      : { label: 'Not signed in', tone: 'attention' }
  return account.hasCredential
    ? { label: 'Signed in', tone: 'ok' }
    : { label: 'Needs sign-in', tone: 'attention' }
}

export interface ProviderCardInput {
  company: ProviderCompanyId
  needsKey: boolean
  hasKey: boolean
  endpoints: readonly ProviderEndpoint[]
}

/** The key's state, in the words the page and its specs read. */
export function providerKeyState(connection: { needsKey: boolean; hasKey: boolean }): CardState {
  if (!connection.needsKey) return { label: 'No key needed', tone: 'quiet' }
  return connection.hasKey
    ? { label: 'Key stored', tone: 'ok' }
    : { label: 'Needs a key', tone: 'attention' }
}

export function providerCardFacts(connection: ProviderCardInput): CardFacts {
  const company = providerCompany(connection.company)
  return {
    company: company.id,
    companyName: company.name,
    what: providerWhat(company),
    state: providerKeyState(connection),
    harnesses: harnessesForEndpoints(connection.endpoints)
  }
}

// ── The cards of what can be connected ──────────────────────────────────────

export interface OfferFacts {
  company: CardCompany
  name: string
  what: string
  harnesses: HarnessId[]
  /** How a connection of it is made: a browser sign-in, or a form. */
  road: 'sign-in' | 'form'
}

/** The companies whose subscriptions Clave signs in to (ADR 0002). */
const SUBSCRIPTION_OFFERS: readonly OfferFacts[] = [
  {
    company: 'anthropic',
    name: 'Anthropic',
    what: 'Claude subscription',
    harnesses: ['claude'],
    road: 'sign-in'
  },
  {
    company: 'openai',
    name: 'OpenAI',
    what: 'ChatGPT subscription',
    harnesses: ['codex'],
    road: 'sign-in'
  }
]

/** Every provider a connection can be made with on a machine, in the order
 *  the page lists them: Anthropic and OpenAI where the subscriptions are
 *  signed in from here (this Mac), then the catalogue. */
export function offerFacts({ subscriptions }: { subscriptions: boolean }): OfferFacts[] {
  const providers: OfferFacts[] = PROVIDER_COMPANIES.map((company) => ({
    company: company.id,
    name: company.name,
    what: providerWhat(company),
    harnesses: harnessesForEndpoints(company.id === 'generic' ? null : company.endpoints),
    road: 'form'
  }))
  return subscriptions ? [...SUBSCRIPTION_OFFERS, ...providers] : providers
}

/** The Connect button of a provider's card: a second one is "another". */
export function connectLabel(connected: number): string {
  return connected > 0 ? 'Connect another' : 'Connect'
}

/** How many of a provider are connected, under its name; null for none. */
export function connectedCountText(connected: number): string | null {
  if (connected <= 0) return null
  return connected === 1 ? '1 connected' : `${connected} connected`
}

// ── The models ──────────────────────────────────────────────────────────────

/** The first few models by name, the rest counted behind one control. */
export function modelPreview<T>(models: readonly T[], shown = 3): { first: T[]; rest: T[] } {
  // One left over is shown rather than hidden behind "1 more".
  const cut = models.length <= shown + 1 ? models.length : shown
  return { first: models.slice(0, cut), rest: models.slice(cut) }
}

/** The fold's control: "4 more", or "Fewer" once unfolded. */
export function moreLabel(rest: number, open: boolean): string {
  return open ? 'Fewer' : `${rest} more`
}

// ── Removing ────────────────────────────────────────────────────────────────

export type RemovalKind =
  | 'claude'
  | 'codex-chatgpt'
  | 'codex-key'
  | 'provider-key'
  | 'provider-local'

/**
 * The confirmation a removal asks, in one question and one sentence of what
 * stops, as the code has it: the credential goes at once (a Claude token or a
 * provider key discarded from the machine's sealed store, a Codex connection's
 * own home deleted with its sign-in); a tab already running keeps the
 * credential its process started with and goes on, and its restart is refused
 * ("no longer available"), so it is moved to another connection first.
 */
export function removalSentence(
  kind: RemovalKind,
  label: string,
  machine: string
): { question: string; consequence: string } {
  const question = `Remove ${label}?`
  const tabs =
    'Tabs running on it keep going until they are restarted, then they need another connection.'
  switch (kind) {
    case 'claude':
      return { question, consequence: `Its token is deleted from ${machine}. ${tabs}` }
    case 'codex-chatgpt':
      return { question, consequence: `Its sign-in is deleted from ${machine}. ${tabs}` }
    case 'codex-key':
    case 'provider-key':
      return { question, consequence: `Its key is deleted from ${machine}. ${tabs}` }
    case 'provider-local':
      return { question, consequence: `Its address is forgotten on ${machine}. ${tabs}` }
  }
}

/** How the confirmation names the machine, at the start of a sentence or inside one. */
export function machineWords(machineName: string | null): string {
  return machineName ?? 'this Mac'
}
