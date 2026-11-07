/**
 * Who a hub bearer names, asked of the hub itself: the relay holds no key
 * and no session of its own. A bearer (an opaque access token or a JWT one,
 * the hub takes both at its userinfo endpoint) is presented to
 * `userinfo_endpoint` as the discovery document names it, and the `sub` it
 * answers is remembered under the SHA-256 of the bearer for ten minutes, or
 * until the token's own `exp` when it is a JWT, since the hub allows 120
 * userinfo calls per minute per IP. A JWT of another issuer, or one already
 * expired, is refused without asking. A hub that does not answer is a 503
 * and never a grant, and nothing of it is cached.
 */
import { createHash } from 'node:crypto'
import { RELAY_AUTH_CACHE_MS } from '@clave/contract/relay'

export interface BearerCheckOptions {
  /** The hub's origin (`https://account.antasphere.com`). */
  readonly issuer: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  readonly cacheMs?: number
  /** Entries kept at most; the oldest go first. */
  readonly maxCached?: number
  readonly requestTimeoutMs?: number
  readonly log?: (line: string) => void
}

export type BearerOutcome =
  | { readonly ok: true; readonly sub: string }
  | { readonly ok: false; readonly status: 401 | 503; readonly reason: string }

/** The hub's userinfo path, when discovery cannot say. */
export const HUB_USERINFO_PATH = '/api/v1/auth/oauth2/userinfo'
const DISCOVERY_PATH = '/.well-known/openid-configuration'
const MAX_METADATA_BYTES = 256 * 1024

/** The token of a `Bearer` authorization header, or null. */
export function bearerOf(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  return token && !/\s/.test(token) ? token : null
}

/** The claims of a JWT, read without verifying it (the hub verifies; what is
 *  read here only shortens a cache entry or refuses early), or null when the
 *  token is not shaped as one. */
export function jwtClaims(token: string): { iss?: string; exp?: number; sub?: string } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
    if (typeof payload !== 'object' || payload === null) return null
    const claims = payload as Record<string, unknown>
    return {
      ...(typeof claims.iss === 'string' && { iss: claims.iss }),
      ...(typeof claims.exp === 'number' && { exp: claims.exp }),
      ...(typeof claims.sub === 'string' && { sub: claims.sub })
    }
  } catch {
    return null
  }
}

export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')

export class HubBearerCheck {
  private readonly cache = new Map<string, { sub: string; until: number }>()
  private readonly fetch: typeof globalThis.fetch
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly maxCached: number
  private readonly timeoutMs: number
  private readonly log: (line: string) => void
  private readonly issuer: URL
  private endpointPromise: Promise<string> | null = null

  constructor(options: BearerCheckOptions) {
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.now = options.now ?? (() => Date.now())
    this.cacheMs = options.cacheMs ?? RELAY_AUTH_CACHE_MS
    this.maxCached = options.maxCached ?? 10_000
    this.timeoutMs = options.requestTimeoutMs ?? 10_000
    this.log = options.log ?? (() => {})
    this.issuer = new URL(options.issuer)
  }

  /** How many subjects are remembered right now (for the tests). */
  get cached(): number {
    return this.cache.size
  }

  /** The userinfo endpoint: the discovery document's when it names one on
   *  the issuer's own origin, the hub's known path otherwise. Discovered
   *  once; a discovery that failed is tried again at the next ask. */
  private endpoint(): Promise<string> {
    if (!this.endpointPromise) {
      this.endpointPromise = this.discover().catch((error: unknown) => {
        this.endpointPromise = null
        throw error
      })
    }
    return this.endpointPromise
  }

  private async discover(): Promise<string> {
    const fallback = new URL(HUB_USERINFO_PATH, this.issuer).toString()
    try {
      const response = await this.bounded(new URL(DISCOVERY_PATH, this.issuer).toString())
      if (response.status !== 200) return fallback
      const text = await response.text()
      if (text.length > MAX_METADATA_BYTES) return fallback
      const metadata = JSON.parse(text) as { userinfo_endpoint?: unknown }
      const named = metadata.userinfo_endpoint
      if (typeof named === 'string' && new URL(named).origin === this.issuer.origin) return named
      return fallback
    } catch {
      return fallback
    }
  }

  private async bounded(url: string, headers?: Record<string, string>): Promise<Response> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.timeoutMs)
    try {
      return await this.fetch(url, { headers, signal: abort.signal, redirect: 'manual' })
    } finally {
      clearTimeout(timer)
    }
  }

  /** The subject a bearer names, from the cache or from the hub. */
  async check(authorization: string | string[] | undefined): Promise<BearerOutcome> {
    const token = bearerOf(authorization)
    if (!token) return { ok: false, status: 401, reason: 'no bearer' }
    const now = this.now()
    const claims = jwtClaims(token)
    if (claims) {
      if (claims.iss !== undefined && claims.iss !== this.issuer.origin)
        return { ok: false, status: 401, reason: 'another issuer' }
      if (claims.exp !== undefined && claims.exp * 1000 <= now)
        return { ok: false, status: 401, reason: 'expired' }
    }
    const key = tokenHash(token)
    const hit = this.cache.get(key)
    if (hit && hit.until > now) return { ok: true, sub: hit.sub }
    if (hit) this.cache.delete(key)
    let response: Response
    try {
      response = await this.bounded(await this.endpoint(), { authorization: `Bearer ${token}` })
    } catch {
      this.log('relay: the hub did not answer a userinfo request')
      return { ok: false, status: 503, reason: 'hub unreachable' }
    }
    // The hub refuses a token it does not know with 401, a malformed one
    // with 400 (measured on account.antasphere.com, 29 October 2026), a
    // token of a client with no standing with 403: all three are a refusal.
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      return { ok: false, status: 401, reason: 'refused by the hub' }
    }
    if (response.status !== 200) {
      await response.body?.cancel()
      this.log(`relay: the hub answered ${response.status} to a userinfo request`)
      return { ok: false, status: 503, reason: `hub answered ${response.status}` }
    }
    let sub: unknown
    try {
      sub = ((await response.json()) as { sub?: unknown }).sub
    } catch {
      return { ok: false, status: 503, reason: 'hub answer unreadable' }
    }
    if (typeof sub !== 'string' || !sub) return { ok: false, status: 503, reason: 'no subject' }
    // The JWT's own end bounds the entry; a claimed `sub` must agree with the hub's.
    if (claims?.sub !== undefined && claims.sub !== sub)
      return { ok: false, status: 401, reason: 'subject mismatch' }
    let until = now + this.cacheMs
    if (claims?.exp !== undefined) until = Math.min(until, claims.exp * 1000)
    this.remember(key, sub, until)
    return { ok: true, sub }
  }

  private remember(key: string, sub: string, until: number): void {
    const now = this.now()
    for (const [k, entry] of this.cache) if (entry.until <= now) this.cache.delete(k)
    while (this.cache.size >= this.maxCached) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    this.cache.set(key, { sub, until })
  }

  /** Forget everything remembered (the tests, and a relay told to). */
  clear(): void {
    this.cache.clear()
  }
}
