/**
 * The usage line of a stored provider connection (PRDCT-4496), read on demand.
 * Romain's rule of 13 November 2026: a figure only where the provider
 * documents how to read what is left; "Pay per use" otherwise, and a coding
 * plan whose console alone shows what is left reads "Coding plan". The
 * endpoints below were read on 13 November 2026 from each provider's own
 * documentation, linked beside its road. The connection's value travels in
 * the request header and nowhere else: no error, no log, no returned line.
 */

import type { ProviderCompanyId } from '@clave/contract/settings/provider-catalogue'
// Lane C of the harness wave (PRDCT-4496): the usage line, the window's shape
import {
  usageLineText,
  type ProviderUsageLineView
} from '@clave/contract/settings/provider-usage-view'

/** The line and its text live in the contract, which the window loads; they
 *  keep their names here. */
export type ProviderUsageLine = ProviderUsageLineView
export { usageLineText }

// ── The parsers: pure, never throwing ───────────────────────────────────────

/** Two decimals, no thousands separator, from a number or a numeric string;
 *  null when the value is neither. */
function amount(value: unknown): string | null {
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value)
  else return null
  return Number.isFinite(n) ? n.toFixed(2) : null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function unknown(reason: string): ProviderUsageLine {
  return { kind: 'unknown', reason }
}

/** DeepSeek, `GET /user/balance` (https://api-docs.deepseek.com/api/get-user-balance):
 *  `{ is_available, balance_infos: [{ currency, total_balance, granted_balance,
 *  topped_up_balance }] }`. The USD entry when there is one, else the first.
 *  `is_available: false` with a zero balance is still a balance: zero left. */
export function parseDeepSeekBalance(body: unknown): ProviderUsageLine {
  const infos = record(body)?.balance_infos
  if (!Array.isArray(infos) || infos.length === 0)
    return unknown('DeepSeek answered without a balance.')
  const entries = infos.map(record)
  const entry = entries.find((e) => e?.currency === 'USD') ?? entries[0]
  const left = amount(entry?.total_balance)
  if (!entry || left === null || typeof entry.currency !== 'string' || !entry.currency)
    return unknown('DeepSeek answered with a balance Clave cannot read.')
  return { kind: 'balance', left, currency: entry.currency }
}

/** OpenRouter, `GET /api/v1/key` (https://openrouter.ai/docs/api/reference/limits):
 *  `{ data: { limit: number | null, limit_remaining: number | null, usage, … } }`
 *  in USD. A key with a limit shows what is left of it; one without shows
 *  what it has spent. */
export function parseOpenRouterKey(body: unknown): ProviderUsageLine {
  const data = record(record(body)?.data)
  if (!data) return unknown('OpenRouter answered without the key.')
  if (typeof data.limit === 'number') {
    const left = amount(data.limit_remaining)
    const of = amount(data.limit)
    if (left === null || of === null)
      return unknown('OpenRouter answered with a limit Clave cannot read.')
    return { kind: 'limit', left, of, currency: 'USD' }
  }
  const used = amount(data.usage)
  if (used === null) return unknown('OpenRouter answered without the usage.')
  return { kind: 'used', used, currency: 'USD' }
}

/** Vercel AI Gateway, `GET /v1/credits`
 *  (https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api):
 *  `{ balance: string, total_used: string }`, USD. */
export function parseVercelCredits(body: unknown): ProviderUsageLine {
  const left = amount(record(body)?.balance)
  if (left === null) return unknown('Vercel answered without a balance.')
  return { kind: 'balance', left, currency: 'USD' }
}

// ── The roads ───────────────────────────────────────────────────────────────

export interface ProviderUsageRoad {
  url: string
  parse: (body: unknown) => ProviderUsageLine
}

/**
 * Per company, the documented endpoint and its parser, or the fixed line.
 * MiniMax documents `https://www.minimax.io/v1/token_plan/remains` for its
 * coding plan (https://platform.minimax.io/docs/m-plan/faq.md) but, as read on
 * 13 November 2026, not one field of its answer: a reader would guess, so it
 * keeps the plan line. Kimi For Coding, Z.ai and the Alibaba Coding Plan
 * document no endpoint at all; their consoles show what is left.
 */
export const PROVIDER_USAGE_ROADS: Readonly<
  Record<ProviderCompanyId, ProviderUsageRoad | ProviderUsageLine>
> = {
  deepseek: { url: 'https://api.deepseek.com/user/balance', parse: parseDeepSeekBalance },
  openrouter: { url: 'https://openrouter.ai/api/v1/key', parse: parseOpenRouterKey },
  'vercel-ai-gateway': {
    url: 'https://ai-gateway.vercel.sh/v1/credits',
    parse: parseVercelCredits
  },
  minimax: { kind: 'plan' },
  moonshot: { kind: 'plan' },
  zai: { kind: 'plan' },
  alibaba: { kind: 'plan' },
  mistral: { kind: 'payPerUse' },
  generic: { kind: 'payPerUse' },
  ollama: { kind: 'local' }
}

function isRoad(entry: ProviderUsageRoad | ProviderUsageLine): entry is ProviderUsageRoad {
  return 'url' in entry
}

// ── The reader ──────────────────────────────────────────────────────────────

const NO_KEY = 'The connection has no key.'
const REFUSED = 'The provider refused the connection.'
const UNREACHABLE = 'The provider could not be reached.'

export interface ProviderUsageDeps {
  /** The connection's value, opened for this one request; null when none. */
  openValue: (connectionId: string) => Promise<string | null>
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
  cacheMs?: number
}

export interface ProviderConnectionRef {
  id: string
  company: ProviderCompanyId
}

/**
 * One cache entry per connection, good for five minutes: the line is read
 * when a window asks for it, never on a clock. Reads of one connection made
 * while a request is out share that request; `force` (the Refresh button)
 * starts its own. A connection with no key is not cached, so a key pasted a
 * moment later shows at the next read.
 */
export class ProviderUsage {
  private cache = new Map<string, { line: ProviderUsageLine; at: number }>()
  private inFlight = new Map<string, Promise<ProviderUsageLine>>()
  // Bumped by invalidate: a read started before it says nothing about the
  // new key, so it answers its caller but leaves the cache alone.
  private generation = new Map<string, number>()
  private readonly timeoutMs: number
  private readonly cacheMs: number
  private readonly now: () => number

  constructor(private deps: ProviderUsageDeps) {
    this.timeoutMs = deps.timeoutMs ?? 10_000
    this.cacheMs = deps.cacheMs ?? 5 * 60_000
    this.now = deps.now ?? Date.now
  }

  async read(
    connection: ProviderConnectionRef,
    options: { force?: boolean } = {}
  ): Promise<ProviderUsageLine> {
    const entry = PROVIDER_USAGE_ROADS[connection.company]
    if (!entry) return unknown('Clave does not know this provider.')
    if (!isRoad(entry)) return entry
    const cached = this.cache.get(connection.id)
    if (!options.force && cached && this.now() - cached.at < this.cacheMs) return cached.line
    const pending = this.inFlight.get(connection.id)
    if (pending && !options.force) return pending
    const read = this.fetchLine(connection.id, entry).finally(() => {
      if (this.inFlight.get(connection.id) === read) this.inFlight.delete(connection.id)
    })
    this.inFlight.set(connection.id, read)
    return read
  }

  /** Drop a connection's cached line: its key changed, or it is gone. */
  invalidate(connectionId: string): void {
    this.cache.delete(connectionId)
    this.inFlight.delete(connectionId)
    this.generation.set(connectionId, (this.generation.get(connectionId) ?? 0) + 1)
  }

  private async fetchLine(
    connectionId: string,
    road: ProviderUsageRoad
  ): Promise<ProviderUsageLine> {
    const generation = this.generation.get(connectionId) ?? 0
    let value: string | null
    try {
      value = await this.deps.openValue(connectionId)
    } catch {
      value = null
    }
    if (!value) return unknown(NO_KEY)
    const line = await this.request(road, value)
    if ((this.generation.get(connectionId) ?? 0) === generation)
      this.cache.set(connectionId, { line, at: this.now() })
    return line
  }

  private async request(road: ProviderUsageRoad, value: string): Promise<ProviderUsageLine> {
    const doFetch = this.deps.fetch ?? globalThis.fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await doFetch(road.url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${value}`, accept: 'application/json' },
        signal: controller.signal
      })
      if (response.status === 401 || response.status === 403) return unknown(REFUSED)
      if (response.status !== 200) return unknown(`The provider answered ${response.status}.`)
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return unknown('The provider answered something other than JSON.')
      }
      return road.parse(body)
    } catch {
      // Never the error itself: its text is the runtime's, not ours to show.
      return unknown(UNREACHABLE)
    } finally {
      clearTimeout(timer)
    }
  }
}

// ── The app's instance ──────────────────────────────────────────────────────

let source: (connectionId: string) => Promise<string | null> = async () => null

/** Where the app's instance opens a connection's value: the connection store
 *  sets it once it exists. */
export function setConnectionValueSource(
  fn: (connectionId: string) => Promise<string | null>
): void {
  source = fn
}

export const providerUsage = new ProviderUsage({ openValue: (id) => source(id) })

// Lane C of the harness wave (PRDCT-4496): the usage line reaches the window

let refSource: (
  connectionId: string
) => Promise<{ id: string; company: ProviderCompanyId } | null> = async () => null

/** Where the app's instance finds a connection by its id: the connection
 *  store sets it once it exists. */
export function setConnectionRefSource(
  fn: (connectionId: string) => Promise<{ id: string; company: ProviderCompanyId } | null>
): void {
  refSource = fn
}

const NOT_KNOWN = 'The connection is not known here.'

/** A connection's usage line as a window reads it, on either road (IPC or the
 *  server's `ReadProviderUsage`), read again first with `force`. Never
 *  rejects: a connection this host does not know is the unknown line. */
export async function providerUsageView(input: {
  connectionId: string
  force?: boolean
}): Promise<ProviderUsageLineView> {
  let ref: { id: string; company: ProviderCompanyId } | null
  try {
    ref = await refSource(input.connectionId)
  } catch {
    ref = null
  }
  if (!ref) return unknown(NOT_KNOWN)
  try {
    return await providerUsage.read(ref, { force: input.force === true })
  } catch {
    return unknown(UNREACHABLE)
  }
}
