import { execFile } from 'child_process'
import os from 'os'
import { promisify } from 'util'
import {
  claudeAccountsManager,
  DEFAULT_CLAUDE_ACCOUNT_ID,
  type ClaudeAccount
} from './claude-accounts'

const execFileAsync = promisify(execFile)

// The usage endpoint Claude Code itself queries to populate the `rate_limits`
// block of its statusline JSON. It needs the `user:profile` scope, which a
// login credential has and a `claude setup-token` token does NOT (that one is
// inference-only): a token account reads its quota from the probe below instead.
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const OAUTH_BETA = 'oauth-2025-04-20'
const API_VERSION = '2023-06-01'
// A keychain read that has not answered in this long is a prompt nobody is
// looking at. Give up and report it rather than hang the caller forever.
const KEYCHAIN_TIMEOUT_MS = 10_000
const FETCH_TIMEOUT_MS = 15_000

/** The probe: the smallest request the API answers with the account's unified
 *  rate-limit headers (the 5-hour and weekly windows, their utilization, their
 *  reset times, the service's own verdict on each). One output token, a
 *  two-word prompt: about twenty tokens per read, twelve reads an hour under
 *  the poll below. A token count (free) answers with no such headers, so it
 *  cannot replace this.
 *
 *  The headers describe the windows the REQUESTED model is subject to: a
 *  Haiku probe carries the session and the weekly all-models windows only,
 *  while the same probe on Fable also carries the Fable weekly cap (measured
 *  on 2026-09-15: the machine login's endpoint read said 74% on that cap, and
 *  the Fable probe's third window said 0.74). So the probe asks Fable first,
 *  and falls back to the cheapest model for an account whose plan has no
 *  Fable, where the service refuses the model outright. */
export const PROBE_MODELS = ['claude-fable-5-1', 'claude-haiku-4-5-20251001'] as const
export const PROBE_MODEL = PROBE_MODELS[PROBE_MODELS.length - 1]
/** The service only serves Fable to a request that identifies as a current
 *  Claude Code: the CLI's own system prompt and a `claude-cli/<version>` user
 *  agent, 2.1.251 or newer as of 2026-09-15 (an older version is answered with
 *  a 400 naming the version required; no identification at all is a bare 429
 *  with no headers). The fallback above covers a version the service stops
 *  accepting: the read then carries the two windows a Haiku probe carries. */
export const PROBE_CLI_VERSION = '2.1.272'
const PROBE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."
export function probeBody(model: string): string {
  return JSON.stringify({
    model,
    max_tokens: 1,
    system: PROBE_SYSTEM,
    messages: [{ role: 'user', content: 'hi' }]
  })
}

/** How long a read stays good for every window that asks; the poll in
 *  `startPolling` refreshes every account on this same clock. */
export const USAGE_CACHE_MS = 5 * 60_000

// One usage window (5-hour block or a weekly cap), normalized for the UI.
export interface UsageWindow {
  key: string
  label: string
  // The service's own kind — 'session', 'weekly_all', 'weekly_scoped', or
  // whatever it invents next. Carried through so a consumer can pick a window
  // by what it IS rather than by parsing the composite key or the prose label.
  kind: string
  // What a scoped limit is scoped to ('Fable', 'Opus'), else null. The short
  // name for a cap, which is what a one-line readout has room for.
  scope: string | null
  // 0–100, already a percentage of the cap consumed.
  usedPercentage: number
  // Unix epoch milliseconds when this window resets, or null if unknown.
  resetsAt: number | null
  // The service's own urgency verdict, when it sends one. Plan-aware, so it can
  // disagree with a naive percentage threshold — prefer it over guessing.
  severity: 'normal' | 'warning' | 'critical' | null
}

export interface UsageLimits {
  windows: UsageWindow[]
  fetchedAt: number
  message?: string
}

// Distinguishes "we couldn't load it" from "it loaded and you're at 0%".
export interface UsageError {
  error: string
  /** The service refused the credential itself: the account is dead until a
   *  new one lands, and the pool must not offer it. */
  reason?: 'unauthorized'
}

// Legacy fallback only. The endpoint's flat `seven_day_<model>` keys are frozen in
// time — per-model caps introduced after them (Fable) never got a key and read null
// here forever — so these are used only when `limits` is missing from the response.
const WINDOW_DEFS: { key: string; label: string }[] = [
  { key: 'five_hour', label: 'Current session (5h)' },
  { key: 'seven_day', label: 'Weekly · all models' },
  { key: 'seven_day_opus', label: 'Weekly · Opus' }
]

// Display order by limit kind; anything unrecognized sorts last but still renders.
const KIND_RANK: Record<string, number> = {
  session: 0,
  weekly_all: 1,
  weekly_scoped: 2
}

interface RawWindow {
  utilization?: number | null
  resets_at?: string | null
}

interface RawScopeName {
  display_name?: string | null
}

// The `limits` array is self-describing: each entry names its own kind and scope,
// so a per-model cap we've never heard of still renders with the right label.
interface RawLimit {
  kind?: string | null
  percent?: number | null
  severity?: string | null
  resets_at?: string | null
  scope?: {
    model?: RawScopeName | null
    surface?: RawScopeName | null
  } | null
}

interface RawUsageBody {
  limits?: RawLimit[] | null
}

/** Where an account's credential comes from, in the order a read tries them. */
export type ClaudeCredential =
  | { kind: 'token'; token: string }
  | { kind: 'keychain' }
  /** An account with nothing to read with yet: never the machine login. */
  | { kind: 'none' }

// ASYNC, and it must stay async. `security` can block: macOS puts up an access
// prompt when the keychain item's ACL does not already cover this binary, and it
// answers at whatever speed a human does. execFileSync would hold the ENTIRE
// main process for that — every window, every PTY, every IPC reply — behind a
// dialog that may be sitting behind the app. `security` lives at a fixed system
// path, so execFile (not exec) still avoids the login-shell dance.
//
// The item is looked up by ACCOUNT first. Claude Code writes its login under
// the macOS username, but a machine can also carry a second item with the same
// service name (account "unknown", holding only `mcpOAuth`), and a lookup by
// service alone answers whichever macOS finds first. When that was the stray
// one, a signed-in user read as signed out. The service-only lookup stays as
// the fallback for a login written under some other account.
async function readKeychainAccessToken(): Promise<string | null> {
  const lookups = [['-a', os.userInfo().username], []]
  for (const account of lookups) {
    const token = await readKeychainItem(account)
    if (token) return token
  }
  return null
}

async function readKeychainItem(account: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, ...account, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS }
    )
    return accessTokenOf(JSON.parse(stdout.trim()))
  } catch {
    return null
  }
}

function accessTokenOf(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const oauth = (record.claudeAiOauth ?? record) as Record<string, unknown>
  return typeof oauth.accessToken === 'string' ? oauth.accessToken : null
}

function parseResetsAt(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function parseSeverity(value: string | null | undefined): UsageWindow['severity'] {
  return value === 'normal' || value === 'warning' || value === 'critical' ? value : null
}

// "weekly_scoped" → "Weekly scoped", so an unrecognized kind still reads as words.
function humanizeKind(kind: string): string {
  const spaced = kind.replace(/[_-]/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// A scoped limit is named by what it's scoped to — the model (Fable, Opus) or,
// failing that, the surface — which is the only place a new per-model cap surfaces.
function scopeOf(limit: RawLimit): string {
  return (
    limit.scope?.model?.display_name?.trim() || limit.scope?.surface?.display_name?.trim() || ''
  )
}

function labelForLimit(limit: RawLimit): string {
  const kind = limit.kind ?? ''
  const scopeName = scopeOf(limit)

  if (kind === 'session') return 'Current session (5h)'
  if (kind === 'weekly_all') return 'Weekly · all models'
  if (kind === 'weekly_scoped') return scopeName ? `Weekly · ${scopeName}` : 'Weekly · scoped'
  const base = kind ? humanizeKind(kind) : 'Usage'
  return scopeName ? `${base} · ${scopeName}` : base
}

function normalizeLimits(limits: RawLimit[]): UsageWindow[] {
  const ranked: { window: UsageWindow; rank: number; index: number }[] = []
  const seenKeys = new Set<string>()

  limits.forEach((limit, index) => {
    if (!limit || limit.percent == null) return
    const label = labelForLimit(limit)
    const kind = limit.kind ?? 'limit'

    // Two scoped limits share a kind, so the label disambiguates the React key.
    let key = `${kind}:${label}`
    while (seenKeys.has(key)) key = `${key}:${index}`
    seenKeys.add(key)

    ranked.push({
      window: {
        key,
        label,
        kind,
        scope: scopeOf(limit) || null,
        usedPercentage: Math.max(0, Math.min(100, limit.percent)),
        resetsAt: parseResetsAt(limit.resets_at),
        severity: parseSeverity(limit.severity)
      },
      rank: KIND_RANK[kind] ?? Number.MAX_SAFE_INTEGER,
      index
    })
  })

  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.window)
}

function normalizeLegacyWindows(raw: Record<string, RawWindow | null>): UsageWindow[] {
  const windows: UsageWindow[] = []
  for (const { key, label } of WINDOW_DEFS) {
    const w = raw[key]
    if (!w || w.utilization == null) continue
    windows.push({
      key,
      label,
      // The legacy keys ARE the kind, and only one of them is scoped.
      kind: key === 'five_hour' ? 'session' : key === 'seven_day' ? 'weekly_all' : 'weekly_scoped',
      scope: key === 'seven_day_opus' ? 'Opus' : null,
      usedPercentage: Math.max(0, Math.min(100, w.utilization)),
      resetsAt: parseResetsAt(w.resets_at),
      severity: null
    })
  }
  return windows
}

export function normalize(body: RawUsageBody): UsageWindow[] {
  if (Array.isArray(body.limits)) {
    const windows = normalizeLimits(body.limits)
    if (windows.length > 0) return windows
  }
  return normalizeLegacyWindows(body as unknown as Record<string, RawWindow | null>)
}

// ── The probe's headers ──────────────────────────────────────────────────────

const UNIFIED_PREFIX = 'anthropic-ratelimit-unified-'

/** The service's verdict on a window, as the header spells it. */
function severityOfStatus(status: string | null): UsageWindow['severity'] {
  if (status === 'allowed') return 'normal'
  if (status === 'allowed_warning') return 'warning'
  if (status === 'rejected') return 'critical'
  return null
}

/** What the service calls a scoped weekly cap in its headers. The endpoint's
 *  `limits` array names the model in words; the headers carry a code instead,
 *  and `oi` is the Fable cap (measured 2026-09-15 against the endpoint's own
 *  figure). A code not listed here still renders, under its own letters. */
const SCOPE_NAMES: Record<string, string> = { oi: 'Fable' }

/** `5h` → the session window, `7d` → the weekly all-models cap, `7d-<model>`
 *  or `7d_<code>` → a weekly cap scoped to that model, anything else → its
 *  own words. */
function windowShapeOf(name: string): { kind: string; scope: string | null; label: string } {
  if (name === '5h') return { kind: 'session', scope: null, label: 'Current session (5h)' }
  if (name === '7d') return { kind: 'weekly_all', scope: null, label: 'Weekly · all models' }
  const scoped = /^7d[-_](.+)$/.exec(name)
  if (scoped) {
    const scope = SCOPE_NAMES[scoped[1]] ?? humanizeKind(scoped[1])
    return { kind: 'weekly_scoped', scope, label: `Weekly · ${scope}` }
  }
  const label = humanizeKind(name)
  return { kind: name, scope: null, label }
}

/**
 * The unified rate-limit headers of a Messages response, read into the same
 * windows the usage endpoint yields, so every consumer downstream is blind to
 * which read produced them. Self-describing like the endpoint's `limits`: every
 * `<name>-utilization` header is a window, its `<name>-reset` (epoch seconds)
 * and `<name>-status` beside it. Utilization arrives as a fraction of the cap
 * (0.21 = 21%); a value above 1 is taken as a percentage already.
 */
export function parseUnifiedRateLimitHeaders(get: (name: string) => string | null): UsageWindow[] {
  return parseUnifiedRateLimitEntries(collectUnifiedHeaders(get))
}

/** The same, from the list a `Headers.forEach` hands over. */
export function parseUnifiedRateLimitEntries(entries: [string, string][]): UsageWindow[] {
  const byName = new Map<string, Record<string, string>>()
  for (const [rawKey, value] of entries) {
    const key = rawKey.toLowerCase()
    if (!key.startsWith(UNIFIED_PREFIX)) continue
    const rest = key.slice(UNIFIED_PREFIX.length)
    const match = /^(.+)-(utilization|reset|status)$/.exec(rest)
    if (!match) continue
    const [, name, field] = match
    const bucket = byName.get(name) ?? {}
    bucket[field] = value
    byName.set(name, bucket)
  }
  const ranked: { window: UsageWindow; rank: number; index: number }[] = []
  let index = 0
  for (const [name, fields] of byName) {
    if (fields.utilization === undefined) continue
    const utilization = Number(fields.utilization)
    if (!Number.isFinite(utilization)) continue
    const percent = utilization <= 1 ? utilization * 100 : utilization
    const reset = fields.reset !== undefined ? Number(fields.reset) : NaN
    const shape = windowShapeOf(name)
    ranked.push({
      window: {
        key: `${shape.kind}:${shape.label}`,
        label: shape.label,
        kind: shape.kind,
        scope: shape.scope,
        usedPercentage: Math.max(0, Math.min(100, Math.round(percent * 10) / 10)),
        resetsAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
        severity: severityOfStatus(fields.status ?? null)
      },
      rank: KIND_RANK[shape.kind] ?? Number.MAX_SAFE_INTEGER,
      index: index++
    })
  }
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.window)
}

// The names the probe's headers are known to carry, so a `get`-shaped source
// (a Headers object, a test) can be walked without enumeration.
const KNOWN_UNIFIED_WINDOWS = ['5h', '7d', '7d_oi']
function collectUnifiedHeaders(get: (name: string) => string | null): [string, string][] {
  const entries: [string, string][] = []
  for (const name of KNOWN_UNIFIED_WINDOWS) {
    for (const field of ['utilization', 'reset', 'status']) {
      const value = get(`${UNIFIED_PREFIX}${name}-${field}`)
      if (value !== null) entries.push([`${UNIFIED_PREFIX}${name}-${field}`, value])
    }
  }
  return entries
}

function headerEntries(headers: Headers): [string, string][] {
  const entries: [string, string][] = []
  headers.forEach((value, key) => entries.push([key, value]))
  return entries
}

// ── The reads ────────────────────────────────────────────────────────────────

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** The usage endpoint, with a login credential (keychain or config dir). */
async function readFromEndpoint(token: string): Promise<UsageLimits | UsageError> {
  let res: Response
  try {
    res = await fetchWithTimeout(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA
      }
    })
  } catch {
    return { error: 'Could not reach the usage service. Check your connection.' }
  }

  if (res.status === 401) {
    return {
      error: 'Your Claude Code session expired. Run a session to refresh it.',
      reason: 'unauthorized'
    }
  }
  if (!res.ok) {
    return { error: `Usage service returned ${res.status}.` }
  }

  let body: RawUsageBody
  try {
    body = (await res.json()) as RawUsageBody
  } catch {
    return { error: 'Got an unexpected response from the usage service.' }
  }

  return { windows: normalize(body), fetchedAt: Date.now() }
}

/** The probe, with a pasted token: the quota is read off the response headers.
 *  A 429 still carries them (that is the window being exhausted, not an error
 *  in the read), so the headers win over the status whenever they are there.
 *  The models are tried in order: an answer with windows ends the read, a
 *  refused token ends it too (the next model would be refused the same), and
 *  anything else (the model not served to this account, a version the
 *  service no longer accepts) moves on to the next model. */
async function readFromProbe(token: string): Promise<UsageLimits | UsageError> {
  let last: Response | null = null
  for (const model of PROBE_MODELS) {
    let res: Response
    try {
      res = await fetchWithTimeout(MESSAGES_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
          'user-agent': `claude-cli/${PROBE_CLI_VERSION} (external, cli)`,
          'x-app': 'cli'
        },
        body: probeBody(model)
      })
    } catch {
      return { error: 'Could not reach Anthropic. Check your connection.' }
    }
    // Drain the body so the connection is released; its content is not the point.
    void res.text().catch(() => undefined)

    const windows = parseUnifiedRateLimitEntries(headerEntries(res.headers))
    if (windows.length > 0) return { windows, fetchedAt: Date.now() }
    if (res.status === 401 || res.status === 403) {
      return {
        error: 'This token was refused. Sign in again to get a new one.',
        reason: 'unauthorized'
      }
    }
    last = res
  }
  if (last && !last.ok) {
    return { error: `Anthropic returned ${last.status}.` }
  }
  return { error: 'Anthropic answered without any usage windows.' }
}

/** Which credential an account reads with. Exported for the tests. */
export function credentialFor(
  account: ClaudeAccount | undefined,
  token: string | undefined
): ClaudeCredential {
  if (token) return { kind: 'token', token }
  // Only the Default account is the machine login. Another account with no
  // token has nothing to read with: reading the keychain for it would show
  // the wrong subscription's quota under its name (and put up the keychain
  // prompt for nothing).
  if (account && account.id !== DEFAULT_CLAUDE_ACCOUNT_ID) return { kind: 'none' }
  return { kind: 'keychain' }
}

export async function readLimitsWith(
  credential: ClaudeCredential
): Promise<UsageLimits | UsageError> {
  if (credential.kind === 'token') return readFromProbe(credential.token)
  if (credential.kind === 'none') {
    return { error: 'No token for this account yet. Log in from Settings → Accounts.' }
  }
  const token = await readKeychainAccessToken()
  if (!token) return { error: 'Sign in to Claude Code to see usage limits.' }
  return readFromEndpoint(token)
}

type CacheEntry = { result: UsageLimits | UsageError; at: number }
type UpdateListener = (accountId: string, result: UsageLimits | UsageError) => void

/** What a provider's manager needs to read its accounts: which ids exist,
 *  and one read per id. Pure over the account store, so the two providers
 *  share the cache, the clock and the ordering rules below. */
export interface AccountUsageSource {
  ids(): string[]
  exists(id: string): boolean
  read(id: string): Promise<UsageLimits | UsageError>
  /** A read the service refused: the credential is dead. */
  onUnauthorized?(id: string): void
}

/**
 * One cache per account, refreshed on a five-minute clock for EVERY account
 * whether or not a window is looking, so the readout in settings and the
 * launcher's account rows are current the moment they open. Reads for
 * different accounts run in parallel: the keychain's ten-second stall (a
 * prompt behind the app) costs one account's read, never N in a row.
 */
export class AccountUsageManager {
  private cache = new Map<string, CacheEntry>()
  private inFlight = new Map<string, Promise<UsageLimits | UsageError>>()
  // The number of the latest read started per account: a read that finishes
  // after a newer one started says nothing (see getLimits).
  private latest = new Map<string, number>()
  private listeners = new Set<UpdateListener>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private source: AccountUsageSource,
    private defaultId: string
  ) {}

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The cached read for every account, for a window that just opened. */
  snapshot(): Record<string, UsageLimits | UsageError> {
    const out: Record<string, UsageLimits | UsageError> = {}
    for (const [id, entry] of this.cache) out[id] = entry.result
    return out
  }

  /** The account's limits: the cache while it is fresh, else a live read.
   *  `force` reads live whatever the cache says (the Refresh button, a token
   *  just pasted). The Default account is the machine's own login.
   *
   *  A forced read never joins a read already in flight: the one in flight
   *  may have started BEFORE the token landed (the settings page asks for a
   *  new account's usage the instant the account exists, the token arrives a
   *  call later) and would answer with the machine login's verdict. It
   *  starts its own, and the older read, finishing later, is discarded
   *  rather than allowed to overwrite the newer answer. */
  async getLimits(
    accountId: string = this.defaultId,
    options: { force?: boolean } = {}
  ): Promise<UsageLimits | UsageError> {
    const cached = this.cache.get(accountId)
    if (!options.force && cached && Date.now() - cached.at < USAGE_CACHE_MS) return cached.result
    const pending = this.inFlight.get(accountId)
    if (pending && !options.force) return pending
    const number = (this.latest.get(accountId) ?? 0) + 1
    this.latest.set(accountId, number)
    const read = (async () => {
      if (accountId !== this.defaultId && !this.source.exists(accountId)) {
        return { error: 'This account no longer exists.' } as UsageError
      }
      const result = await this.source.read(accountId)
      if (this.latest.get(accountId) === number) {
        this.cache.set(accountId, { result, at: Date.now() })
        if ('error' in result && result.reason === 'unauthorized') {
          this.source.onUnauthorized?.(accountId)
        }
        for (const listener of this.listeners) listener(accountId, result)
      }
      return result
    })()
    this.inFlight.set(accountId, read)
    try {
      return await read
    } finally {
      if (this.inFlight.get(accountId) === read) this.inFlight.delete(accountId)
    }
  }

  /** Every account, live, in parallel. */
  async refreshAll(): Promise<void> {
    await Promise.all(this.source.ids().map((id) => this.getLimits(id, { force: true })))
  }

  /** Drop what is known about an account (its token was cleared, or it was
   *  removed): the cache, and any read still in flight, which must not land
   *  the forgotten credential's answer once it returns. */
  forget(accountId: string): void {
    this.cache.delete(accountId)
    this.inFlight.delete(accountId)
    this.latest.set(accountId, (this.latest.get(accountId) ?? 0) + 1)
  }

  /** The five-minute clock. Idempotent; `stopPolling` at quit. `shouldRun`
   *  is asked at every tick: a probe spends a little of the quota it reads,
   *  so the clock stands still while nobody has a window open. */
  startPolling(intervalMs: number = USAGE_CACHE_MS, shouldRun: () => boolean = () => true): void {
    if (this.timer) return
    const tick = (): void => {
      if (shouldRun()) void this.refreshAll()
    }
    this.timer = setInterval(tick, intervalMs)
    // Off the boot path: the first read waits for the windows to settle.
    setTimeout(tick, 5_000)
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** The Claude accounts: a token account reads through the probe, the Default
 *  through the keychain, and a refused token marks its account dead. */
export const usageManager = new AccountUsageManager(
  {
    ids: () => claudeAccountsManager.list().map((a) => a.id),
    exists: (id) => !!claudeAccountsManager.get(id),
    read: (id) =>
      readLimitsWith(
        credentialFor(claudeAccountsManager.get(id), claudeAccountsManager.getToken(id))
      ),
    onUnauthorized: (id) => {
      if (claudeAccountsManager.hasToken(id)) claudeAccountsManager.markTokenInvalid(id)
    }
  },
  DEFAULT_CLAUDE_ACCOUNT_ID
)
