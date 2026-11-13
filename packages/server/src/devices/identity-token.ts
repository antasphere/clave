/**
 * The owner's proof: an Antasphere ID token a phone presents, verified here
 * with `node:crypto` alone (no new dependency), against the keys the hub
 * publishes. The checks, in order, each one its own refusal: the owner is
 * signed in (before anything is fetched: a signed-out server never calls
 * the hub), the issuer is acceptable, the token is a compact JWS whose
 * algorithm is RS256 or ES256, a published key matches its `kid` (the keys
 * are fetched once a day and once more on an unknown `kid`, at most once a
 * minute), the signature holds, `iss` is the issuer, `exp` and `nbf` hold
 * with 60 s of skew, `aud` names the client id the phone sent, `azp` names
 * it too when present, and `sub` is the owner's subject. A refusal names
 * the check and never the token.
 */
import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey as NodeJsonWebKey,
  type KeyObject
} from 'node:crypto'
import type { PairingRefusal } from '@clave/contract/devices'

/** The hub, when the environment names no other issuer. The same default
 *  and the same rule as `src/main/antasphere-account.ts`. */
export const DEFAULT_ANTASPHERE_ISSUER = 'https://account.antasphere.com'
/** The environment variable that points a process at a loopback test provider. */
export const ANTASPHERE_ISSUER_ENV = 'CLAVE_ANTASPHERE_ISSUER'
/** Where the hub lists its keys, discovered through the well-known document. */
export const OPENID_CONFIGURATION_PATH = '/.well-known/openid-configuration'
/** The keys are trusted this long before they are read again. */
export const JWKS_TTL_MS = 24 * 60 * 60 * 1000
/** An unknown `kid` reads the keys again at most this often. */
export const JWKS_REFETCH_FLOOR_MS = 60 * 1000
/** Every request to the issuer: this long, this big, no redirects. */
export const JWKS_REQUEST_TIMEOUT_MS = 15_000
export const JWKS_RESPONSE_MAX_BYTES = 256 * 1024
/** How far the phone's clock and the hub's may disagree. */
export const CLOCK_SKEW_S = 60

export interface IssuerConfig {
  issuer: URL
  /** Plain HTTP, allowed for the literal loopback test target and nothing else. */
  insecure: boolean
}

/**
 * The issuer this server trusts: the hub, or the loopback provider named in
 * the environment for a test. Validated rather than trusted: a bare origin,
 * https, or http to the literal `127.0.0.1`. A refused override does NOT
 * fall back to the hub, so a typo never lets production keys in.
 */
export function resolveAntasphereIssuer(
  raw: string | undefined
): { ok: true; config: IssuerConfig } | { ok: false; reason: string } {
  const value = raw?.trim()
  if (!value)
    return { ok: true, config: { issuer: new URL(DEFAULT_ANTASPHERE_ISSUER), insecure: false } }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: 'not a URL' }
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    return { ok: false, reason: 'not a bare origin' }
  if (url.protocol === 'https:') return { ok: true, config: { issuer: url, insecure: false } }
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1')
    return { ok: true, config: { issuer: url, insecure: true } }
  return { ok: false, reason: 'plain http is only accepted for 127.0.0.1' }
}

/** One refusal, by the check that failed. Its message is the sentence the
 *  phone may see; the token is in neither. */
export class IdentityTokenRefused extends Error {
  constructor(
    readonly check: PairingRefusal,
    message: string
  ) {
    super(message)
    this.name = 'IdentityTokenRefused'
  }
}

export interface Jwk {
  readonly kty?: string
  readonly kid?: string
  readonly alg?: string
  readonly use?: string
  readonly crv?: string
  readonly [key: string]: unknown
}

type Alg = 'RS256' | 'ES256'
const ALGS = new Set<string>(['RS256', 'ES256'])

/** A bounded read of a JSON document: this long, this big, no redirect. */
async function readJson(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  timeoutMs: number,
  maxBytes: number
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json' }
    })
    if (response.status !== 200) throw new Error(`the issuer answered ${response.status}`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('the issuer answered no body')
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new Error('the issuer answered too much')
      }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown
  } finally {
    clearTimeout(timer)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The hub's keys, read through its well-known document and kept a day; an
 * unknown `kid` reads them again, at most once a minute. One fetch at a
 * time: concurrent askers share it.
 */
export class JwksCache {
  private keys: ReadonlyArray<Jwk> | null = null
  private fetchedAt = 0
  private lastRefetchAt = 0
  private inflight: Promise<ReadonlyArray<Jwk>> | null = null

  constructor(
    private readonly options: {
      readonly issuer: URL
      readonly fetch?: typeof globalThis.fetch
      readonly now?: () => number
      readonly ttlMs?: number
      readonly refetchFloorMs?: number
      readonly timeoutMs?: number
      readonly maxBytes?: number
    }
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** The keys as trusted now: the cached ones while they are fresh. */
  current(): Promise<ReadonlyArray<Jwk>> {
    if (this.keys && this.now - this.fetchedAt < (this.options.ttlMs ?? JWKS_TTL_MS))
      return Promise.resolve(this.keys)
    return this.load()
  }

  /** The keys read again for a `kid` the cached ones lack; the cached ones
   *  when the last such read was less than a minute ago. */
  refresh(): Promise<ReadonlyArray<Jwk>> {
    if (
      this.keys &&
      this.now - this.lastRefetchAt < (this.options.refetchFloorMs ?? JWKS_REFETCH_FLOOR_MS)
    )
      return Promise.resolve(this.keys)
    this.lastRefetchAt = this.now
    return this.load()
  }

  /** How many times the issuer was read; the tests count. */
  reads = 0

  private load(): Promise<ReadonlyArray<Jwk>> {
    if (this.inflight) return this.inflight
    this.inflight = this.fetchKeys().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async fetchKeys(): Promise<ReadonlyArray<Jwk>> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch
    const timeoutMs = this.options.timeoutMs ?? JWKS_REQUEST_TIMEOUT_MS
    const maxBytes = this.options.maxBytes ?? JWKS_RESPONSE_MAX_BYTES
    const issuer = this.options.issuer
    this.reads += 1
    let keys: ReadonlyArray<Jwk>
    try {
      const discovery = await readJson(
        fetchImpl,
        new URL(OPENID_CONFIGURATION_PATH, issuer),
        timeoutMs,
        maxBytes
      )
      if (!isRecord(discovery) || typeof discovery.jwks_uri !== 'string')
        throw new Error('the discovery document names no jwks_uri')
      const jwksUri = new URL(discovery.jwks_uri)
      // Pinned to the issuer: a key set from anywhere else is nobody's.
      if (jwksUri.origin !== issuer.origin) throw new Error('jwks_uri is off the issuer')
      const document = await readJson(fetchImpl, jwksUri, timeoutMs, maxBytes)
      if (!isRecord(document) || !Array.isArray(document.keys))
        throw new Error('the key set has no keys')
      keys = document.keys.filter(isRecord) as Jwk[]
    } catch (error) {
      throw new IdentityTokenRefused(
        'keys',
        `The hub's keys could not be read: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    this.keys = keys
    this.fetchedAt = this.now
    return keys
  }
}

interface Parsed {
  readonly alg: Alg
  readonly kid: string | undefined
  readonly claims: Record<string, unknown>
  readonly signed: Buffer
  readonly signature: Buffer
}

function parse(token: string): Parsed {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => part.length === 0))
    throw new IdentityTokenRefused('format', 'The token is not a compact JWS.')
  const [h, p, s] = parts as [string, string, string]
  const b64 = /^[A-Za-z0-9_-]+$/
  if (!b64.test(h) || !b64.test(p) || !b64.test(s))
    throw new IdentityTokenRefused('format', 'The token is not a compact JWS.')
  let header: unknown
  let claims: unknown
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf-8'))
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8'))
  } catch {
    throw new IdentityTokenRefused('format', 'The token is not a compact JWS.')
  }
  if (!isRecord(header) || !isRecord(claims))
    throw new IdentityTokenRefused('format', 'The token is not a compact JWS.')
  const alg = header.alg
  if (typeof alg !== 'string' || !ALGS.has(alg))
    throw new IdentityTokenRefused('algorithm', 'The token is not signed with RS256 or ES256.')
  const kid = header.kid
  if (kid !== undefined && typeof kid !== 'string')
    throw new IdentityTokenRefused('format', 'The token names its key badly.')
  return {
    alg: alg as Alg,
    kid,
    claims,
    signed: Buffer.from(`${h}.${p}`, 'ascii'),
    signature: Buffer.from(s, 'base64url')
  }
}

/** The key of a JWK fit for the algorithm: an RSA key of 2048 bits or more
 *  for RS256, a P-256 key for ES256; a JWK that names another algorithm or
 *  another use is not this token's key. */
function keyOf(jwk: Jwk, alg: Alg): KeyObject | null {
  if (jwk.alg !== undefined && jwk.alg !== alg) return null
  if (jwk.use !== undefined && jwk.use !== 'sig') return null
  if (alg === 'RS256' && jwk.kty !== 'RSA') return null
  if (alg === 'ES256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256')) return null
  try {
    const key = createPublicKey({ key: jwk as NodeJsonWebKey, format: 'jwk' })
    if (alg === 'RS256' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return null
    return key
  } catch {
    return null
  }
}

const candidates = (keys: ReadonlyArray<Jwk>, parsed: Parsed): KeyObject[] =>
  keys
    .filter((jwk) => (parsed.kid === undefined ? true : jwk.kid === parsed.kid))
    .map((jwk) => keyOf(jwk, parsed.alg))
    .filter((key): key is KeyObject => key !== null)

function signatureHolds(parsed: Parsed, key: KeyObject): boolean {
  try {
    return parsed.alg === 'RS256'
      ? verifySignature('sha256', parsed.signed, key, parsed.signature)
      : verifySignature(
          'sha256',
          parsed.signed,
          { key, dsaEncoding: 'ieee-p1363' },
          parsed.signature
        )
  } catch {
    return false
  }
}

export interface VerifyInput {
  readonly token: string
  /** The client id the phone registered at the hub and presents with the token. */
  readonly clientId: string
  /** The owner's subject; null when nobody is signed in on this server. */
  readonly ownerSubject: string | null
  readonly issuer: IssuerConfig
  readonly keys: JwksCache
  readonly now?: () => number
}

/** The owner-missing case is not a refusal of the token but of the server:
 *  the handler answers `CapabilityUnavailable` for it. */
export class OwnerMissing extends Error {
  constructor() {
    super('This server has no Antasphere login, so no phone can pair with it.')
    this.name = 'OwnerMissing'
  }
}

/**
 * The checks, in the order above. Answers the token's subject (the owner's)
 * or throws `OwnerMissing` or `IdentityTokenRefused`.
 */
export async function verifyIdentityToken(input: VerifyInput): Promise<{ subject: string }> {
  if (input.ownerSubject === null) throw new OwnerMissing()
  const parsed = parse(input.token)
  let keys = candidates(await input.keys.current(), parsed)
  if (keys.length === 0) keys = candidates(await input.keys.refresh(), parsed)
  if (keys.length === 0)
    throw new IdentityTokenRefused('key', 'The token names a key the hub does not publish.')
  if (!keys.some((key) => signatureHolds(parsed, key)))
    throw new IdentityTokenRefused('signature', 'The token’s signature does not hold.')
  const { claims } = parsed
  const issuer = input.issuer.issuer.origin
  if (claims.iss !== issuer)
    throw new IdentityTokenRefused('issuer', 'The token was not issued by the Antasphere hub.')
  const nowS = Math.floor((input.now ?? Date.now)() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S <= nowS)
    throw new IdentityTokenRefused('expired', 'The token has expired.')
  if (
    claims.nbf !== undefined &&
    (typeof claims.nbf !== 'number' || claims.nbf - CLOCK_SKEW_S > nowS)
  )
    throw new IdentityTokenRefused('not-yet-valid', 'The token is not valid yet.')
  const aud = claims.aud
  const audienceHolds =
    aud === input.clientId || (Array.isArray(aud) && aud.includes(input.clientId))
  if (!audienceHolds)
    throw new IdentityTokenRefused('audience', 'The token was not issued to this phone.')
  if (claims.azp !== undefined && claims.azp !== input.clientId)
    throw new IdentityTokenRefused('authorized-party', 'The token was not issued to this phone.')
  if (typeof claims.sub !== 'string' || claims.sub !== input.ownerSubject)
    throw new IdentityTokenRefused('subject', 'The token is not the owner’s.')
  return { subject: claims.sub }
}
