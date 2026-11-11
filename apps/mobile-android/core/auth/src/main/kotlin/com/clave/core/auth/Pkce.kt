package com.clave.core.auth

import com.clave.core.ports.CryptoPort

/*
 * PKCE (RFC 7636, S256) and the random values of an authorization request. The hub
 * requires S256 for a public native client and for any request asking for offline_access.
 */

/** 32 random bytes as base64url: 43 characters, within RFC 7636's 43 to 128. */
fun makeVerifier(crypto: CryptoPort): String = base64UrlEncode(crypto.randomBytes(32))

/** A `state` or a `nonce`: 16 random bytes as base64url by default. */
fun randomValue(crypto: CryptoPort, bytes: Int = 16): String = base64UrlEncode(crypto.randomBytes(bytes))

/** The S256 challenge: SHA-256 of the verifier's ASCII bytes, as base64url. */
fun challengeOf(verifier: String, crypto: CryptoPort): String = base64UrlEncode(crypto.sha256(asciiBytes(verifier)))
