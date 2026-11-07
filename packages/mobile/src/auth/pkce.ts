/**
 * PKCE (RFC 7636, S256) and the two random values of an authorization
 * request, over an injected crypto port: expo-crypto on the phone
 * (`getRandomBytes`, `digest(SHA256, bytes)`), node:crypto in the tests.
 * The hub requires S256 for a public native client and for any request that
 * asks for `offline_access` (the hub audit of 29 October 2026).
 */
import { asciiBytes, base64urlEncode } from './encoding'

export interface CryptoPort {
  /** `n` bytes from the platform's generator. */
  randomBytes(n: number): Uint8Array
  /** SHA-256 of the bytes. */
  sha256(data: Uint8Array): Promise<Uint8Array>
}

/** 32 random bytes as base64url: 43 characters, within RFC 7636's 43 to 128. */
export const makeVerifier = (crypto: CryptoPort): string => base64urlEncode(crypto.randomBytes(32))

/** A `state` or a `nonce`: 16 random bytes as base64url. */
export const randomValue = (crypto: CryptoPort, bytes = 16): string =>
  base64urlEncode(crypto.randomBytes(bytes))

export async function challengeOf(verifier: string, crypto: CryptoPort): Promise<string> {
  return base64urlEncode(await crypto.sha256(asciiBytes(verifier)))
}
