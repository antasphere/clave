/**
 * The two signed tokens the push platforms take, on `node:crypto` alone: the
 * APNs provider token (ES256, the team's .p8 key) and the Google service
 * account assertion (RS256, the service account's key). `verifyJwt` is what
 * the fakes in the tests check a token with, against the public half.
 */
import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  type KeyObject
} from 'node:crypto'

export type JwtAlgorithm = 'ES256' | 'RS256'

export interface Jwt {
  readonly header: Record<string, unknown>
  readonly claims: Record<string, unknown>
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** `header.alg` is set from `alg`; a JOSE ES256 signature is the raw r||s
 *  pair (`ieee-p1363`), never DER. */
export function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: KeyObject | string,
  alg: JwtAlgorithm
): string {
  const input = `${encode({ ...header, alg })}.${encode(claims)}`
  const privateKey = typeof key === 'string' ? createPrivateKey(key) : key
  const signature = createSign('SHA256')
    .update(input)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }, 'base64url')
  return `${input}.${signature}`
}

/** The token's header and claims when its signature verifies against `key`
 *  with `alg` and its header says so; null otherwise. */
export function verifyJwt(token: string, key: KeyObject | string, alg: JwtAlgorithm): Jwt | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, c, s] = parts
  let header: Record<string, unknown>
  let claims: Record<string, unknown>
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (header.alg !== alg) return null
  let ok: boolean
  try {
    const publicKey = typeof key === 'string' ? createPublicKey(key) : key
    ok = createVerify('SHA256')
      .update(`${h}.${c}`)
      .verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, s, 'base64url')
  } catch {
    return null
  }
  return ok ? { header, claims } : null
}
