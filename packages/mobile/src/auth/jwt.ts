/**
 * The ID token's claims, read on the phone: the decode and the shape
 * checks, nothing more. The phone does not verify the signature: the server
 * does, against the hub's keys, when the token is presented to enroll (lane
 * A, `packages/server/src/devices/identity-token.ts`). What the phone checks
 * is that the token it was handed is the one it asked for: three base64url
 * segments, a JOSE header naming RS256, a payload naming this issuer, this
 * client as the audience, a lifetime that has not passed, and the nonce the
 * phone minted. A token failing any of these is refused by the name of the
 * check, never with the token in the message. The check names are the same
 * words the server's refusal uses, so a log reads the same on both sides.
 */
import { base64urlDecode, utf8Decode } from './encoding'

export interface IdTokenClaims {
  readonly iss: string
  readonly sub: string
  readonly aud: readonly string[]
  readonly exp: number
  readonly iat: number
  readonly nonce?: string
  readonly azp?: string
  readonly name?: string
  readonly email?: string
  readonly emailVerified?: boolean
}

export type IdTokenRefusal =
  | 'format'
  | 'algorithm'
  | 'issuer'
  | 'audience'
  | 'authorized-party'
  | 'expired'
  | 'not-yet-valid'
  | 'nonce'
  | 'subject'

export class IdTokenRefused extends Error {
  constructor(readonly check: IdTokenRefusal) {
    super(`The ID token was refused by the ${check} check.`)
    this.name = 'IdTokenRefused'
  }
}

/** The clock skew the lifetime checks tolerate, the server's own figure. */
export const CLOCK_SKEW_SEC = 60

/** A function declaration, not an arrow: TypeScript narrows after a call to
 *  a `never` function only when the callee is declared with its type. */
function refuse(check: IdTokenRefusal): never {
  throw new IdTokenRefused(check)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function segmentJson(segment: string): Record<string, unknown> {
  if (!segment) refuse('format')
  let parsed: unknown
  try {
    parsed = JSON.parse(utf8Decode(base64urlDecode(segment)))
  } catch {
    refuse('format')
  }
  return isRecord(parsed) ? parsed : refuse('format')
}

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : refuse('format')
}

/** The claims of a compact JWS, by shape alone; throws `IdTokenRefused`. */
export function decodeIdToken(token: string): IdTokenClaims {
  const parts = token.split('.')
  if (parts.length !== 3) refuse('format')
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
  if (!signaturePart) refuse('format')
  try {
    base64urlDecode(signaturePart)
  } catch {
    refuse('format')
  }
  const header = segmentJson(headerPart)
  if (header.typ !== undefined && header.typ !== 'JWT') refuse('format')
  if (header.alg !== 'RS256') refuse('algorithm')
  const payload = segmentJson(payloadPart)
  if (typeof payload.iss !== 'string' || !payload.iss) refuse('format')
  if (typeof payload.sub !== 'string' || !payload.sub) refuse('subject')
  const aud =
    typeof payload.aud === 'string'
      ? [payload.aud]
      : Array.isArray(payload.aud) && payload.aud.every((a) => typeof a === 'string')
        ? (payload.aud as string[])
        : refuse('format')
  if (aud.length === 0) refuse('format')
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) refuse('format')
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) refuse('format')
  if (payload.email_verified !== undefined && typeof payload.email_verified !== 'boolean')
    refuse('format')
  const claims: IdTokenClaims = {
    iss: payload.iss,
    sub: payload.sub,
    aud,
    exp: payload.exp,
    iat: payload.iat,
    nonce: optionalString(payload.nonce),
    azp: optionalString(payload.azp),
    name: optionalString(payload.name),
    email: optionalString(payload.email),
    emailVerified: payload.email_verified as boolean | undefined
  }
  return claims
}

export interface ExpectedIdToken {
  readonly issuer: string
  readonly clientId: string
  /** The nonce the request carried; a token from a refresh carries none. */
  readonly nonce?: string
  /** Epoch milliseconds. */
  readonly now: number
  readonly skewSec?: number
}

/** The claims against what the phone asked for; throws `IdTokenRefused`. */
export function checkIdToken(claims: IdTokenClaims, expected: ExpectedIdToken): void {
  const skew = expected.skewSec ?? CLOCK_SKEW_SEC
  const nowSec = expected.now / 1000
  if (claims.iss !== expected.issuer) refuse('issuer')
  if (!claims.aud.includes(expected.clientId)) refuse('audience')
  if (claims.azp !== undefined && claims.azp !== expected.clientId) refuse('authorized-party')
  if (claims.exp + skew <= nowSec) refuse('expired')
  if (claims.iat - skew > nowSec) refuse('not-yet-valid')
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce) refuse('nonce')
}
