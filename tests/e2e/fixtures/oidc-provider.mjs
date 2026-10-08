// A local OpenID Connect provider for the Antasphere login tests (PRDCT-3259).
//
// It is the hub's public surface, cut down to what the desktop login uses:
// discovery, dynamic client registration, the authorization endpoint (which
// approves on sight, so a test "browser" is one fetch that follows the
// redirect), the token endpoint, the JWKS and userinfo. Every ID token is
// RS256-signed with a key the JWKS publishes, so the client's signature
// validation is exercised for real; `tamper` turns the next token response
// into a wrong one (another key, another issuer, another audience, a stale
// nonce, an expired token), which is how the tests prove a validation exists.
//
// Both the vitest suite (src/main/antasphere-account.test.ts) and the Electron
// spec (tests/e2e/antasphere-account.spec.mjs) start one of these on
// 127.0.0.1 and nothing else: no test ever reaches account.antasphere.com.
import { createServer } from 'node:http'
import { createHash, generateKeyPairSync, randomBytes, sign as signBytes } from 'node:crypto'

const b64url = (input) => Buffer.from(input).toString('base64url')

function makeKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } }
}

/** A compact JWS, RS256 (RSASSA-PKCS1-v1_5 over SHA-256, what `sign` does for an RSA key). */
function signJwt(key, payload, { kid = key.kid } = {}) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
  const body = b64url(JSON.stringify(payload))
  const signature = signBytes('sha256', Buffer.from(`${header}.${body}`), key.privateKey)
  return `${header}.${body}.${signature.toString('base64url')}`
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const DEFAULT_USER = {
  sub: 'user-7f3a',
  name: 'Ada Example',
  email: 'ada@example.test',
  email_verified: true
}

/**
 * Start the provider on a free loopback port. Returns its issuer URL, the
 * knobs the tests turn, and what it has seen.
 *
 *  - `user`: the person every authorization signs in as (sub, name, email).
 *  - `issueRefresh`: whether `offline_access` earns a refresh token.
 *  - `idTokenTtlSec` / `accessTokenTtlSec`: the lifetimes it states.
 *  - `clockSkewSec`: the provider's own clock, for an "expired on arrival" token.
 */
export async function startOidcProvider({
  user = DEFAULT_USER,
  issueRefresh = true,
  idTokenTtlSec = 3600,
  accessTokenTtlSec = 3600
} = {}) {
  const keys = { signing: makeKey('clave-test-signing'), other: makeKey('clave-test-other') }
  const state = {
    user,
    issueRefresh,
    idTokenTtlSec,
    accessTokenTtlSec,
    /** Every request as `{ method, path, body }`, in order. */
    log: [],
    /** The registrations accepted, with the metadata as sent. */
    registrations: [],
    /** The authorization codes issued, by code. */
    codes: new Map(),
    /** The refresh tokens issued, by token: { sub, client_id, scope }. */
    refreshTokens: new Map(),
    /** Set to turn the NEXT token response into a wrong one; cleared after. */
    tamper: null,
    /** The next authorization answers `error=access_denied`. */
    denyNext: false,
    /** Hold the token endpoint's answer this long (ms), for the races. */
    tokenDelayMs: 0,
    /** Hold a refresh grant's answer this long (ms), on top of tokenDelayMs. */
    refreshDelayMs: 0,
    /** Hold the discovery document this long (ms). */
    discoveryDelayMs: 0,
    /** Hold the NEXT registration this long (ms); cleared after. */
    registerDelayOnceMs: 0,
    /** Answer a metadata endpoint on another origin, for the pinning test. */
    foreignTokenEndpoint: null,
    /** Pad the discovery document to this many bytes, for the body bound. */
    discoveryPadBytes: 0,
    /** Refuse registration with this status (e.g. 403), once. */
    refuseRegistrationOnce: null,
    /** The next registration answers a confidential client (a secret). */
    confidentialNext: false,
    /** Refresh grants answer with neither an ID token nor `expires_in`. */
    bareRefresh: false,
    /** The userinfo endpoint answers 500. */
    userinfoFail: false,
    /** Which grant types the registration echoes back (null = as asked). */
    grantTypesOverride: null,
    counts: { discovery: 0, register: 0, authorize: 0, token: 0, refresh: 0, jwks: 0, userinfo: 0 }
  }
  let issuer = ''

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer)
    const body = req.method === 'POST' ? await readBody(req) : ''
    state.log.push({ method: req.method, path: url.pathname, body })

    if (url.pathname === '/.well-known/openid-configuration') {
      state.counts.discovery++
      if (state.discoveryDelayMs > 0)
        await new Promise((r) => setTimeout(r, state.discoveryDelayMs))
      const doc = {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: state.foreignTokenEndpoint ?? `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        registration_endpoint: `${issuer}/register`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
        token_endpoint_auth_methods_supported: [
          'none',
          'client_secret_basic',
          'client_secret_post'
        ],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: [
          'openid',
          'profile',
          'email',
          'offline_access',
          'account:read',
          'account:write'
        ],
        ...(state.discoveryPadBytes > 0 ? { padding: 'x'.repeat(state.discoveryPadBytes) } : {})
      }
      return json(res, 200, doc)
    }

    if (url.pathname === '/jwks') {
      state.counts.jwks++
      return json(res, 200, { keys: [keys.signing.jwk] })
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      state.counts.register++
      if (state.registerDelayOnceMs > 0) {
        const delay = state.registerDelayOnceMs
        state.registerDelayOnceMs = 0
        await new Promise((r) => setTimeout(r, delay))
      }
      if (state.refuseRegistrationOnce !== null) {
        const status = state.refuseRegistrationOnce
        state.refuseRegistrationOnce = null
        return json(res, status, { error: 'invalid_client_metadata' })
      }
      let metadata
      try {
        metadata = JSON.parse(body)
      } catch {
        return json(res, 400, { error: 'invalid_client_metadata' })
      }
      const client_id = `dcr-${randomBytes(6).toString('hex')}`
      const registered = {
        client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: metadata.redirect_uris,
        token_endpoint_auth_method: metadata.token_endpoint_auth_method ?? 'client_secret_basic',
        grant_types: state.grantTypesOverride ?? metadata.grant_types ?? ['authorization_code'],
        response_types: metadata.response_types ?? ['code'],
        client_name: metadata.client_name,
        application_type: metadata.application_type,
        // What the hub hands a client by default, broader than what was asked:
        // the client must keep requesting its own identity scopes regardless.
        scope: 'openid profile email offline_access account:read account:write',
        ...(state.confidentialNext
          ? {
              client_secret: 'not-for-a-native-client',
              client_secret_expires_at: 0,
              token_endpoint_auth_method: 'client_secret_post'
            }
          : {})
      }
      state.confidentialNext = false
      state.registrations.push({ sent: metadata, registered })
      return json(res, 201, registered)
    }

    if (url.pathname === '/authorize' && req.method === 'GET') {
      state.counts.authorize++
      const q = url.searchParams
      const client = state.registrations.find((r) => r.registered.client_id === q.get('client_id'))
      const redirect = q.get('redirect_uri')
      if (!client || !client.registered.redirect_uris.includes(redirect)) {
        return json(res, 400, {
          error: 'invalid_request',
          error_description: 'unknown client or redirect'
        })
      }
      const back = new URL(redirect)
      if (q.get('state')) back.searchParams.set('state', q.get('state'))
      back.searchParams.set('iss', issuer)
      if (
        q.get('response_type') !== 'code' ||
        q.get('code_challenge_method') !== 'S256' ||
        !q.get('code_challenge')
      ) {
        back.searchParams.set('error', 'invalid_request')
      } else if (state.denyNext) {
        state.denyNext = false
        back.searchParams.set('error', 'access_denied')
      } else {
        const code = `code-${randomBytes(8).toString('hex')}`
        state.codes.set(code, {
          client_id: q.get('client_id'),
          redirect_uri: redirect,
          code_challenge: q.get('code_challenge'),
          nonce: q.get('nonce'),
          scope: q.get('scope') ?? '',
          used: false
        })
        back.searchParams.set('code', code)
      }
      res.writeHead(302, { location: back.toString() })
      return res.end()
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      state.counts.token++
      if (state.tokenDelayMs > 0) await new Promise((r) => setTimeout(r, state.tokenDelayMs))
      const form = new URLSearchParams(body)
      const grant = form.get('grant_type')
      const client_id = form.get('client_id')
      const client = state.registrations.find((r) => r.registered.client_id === client_id)
      if (!client) return json(res, 401, { error: 'invalid_client' })
      let sub, scope, nonce
      if (grant === 'authorization_code') {
        const issued = state.codes.get(form.get('code'))
        if (!issued || issued.used || issued.client_id !== client_id) {
          return json(res, 400, { error: 'invalid_grant' })
        }
        if (issued.redirect_uri !== form.get('redirect_uri')) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri' })
        }
        const verifier = form.get('code_verifier') ?? ''
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        if (challenge !== issued.code_challenge) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' })
        }
        issued.used = true
        sub = state.user.sub
        scope = issued.scope
        nonce = issued.nonce
      } else if (grant === 'refresh_token') {
        state.counts.refresh++
        if (state.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, state.refreshDelayMs))
        const issued = state.refreshTokens.get(form.get('refresh_token'))
        if (!issued || issued.client_id !== client_id)
          return json(res, 400, { error: 'invalid_grant' })
        sub = issued.sub
        scope = issued.scope
        nonce = undefined
      } else {
        return json(res, 400, { error: 'unsupported_grant_type' })
      }
      const now = Math.floor(Date.now() / 1000)
      const tamper = state.tamper
      state.tamper = null
      const claims = {
        iss: tamper?.iss ?? issuer,
        sub: tamper?.sub ?? sub,
        aud: tamper?.aud ?? client_id,
        exp: tamper?.exp ?? now + state.idTokenTtlSec,
        iat: now,
        ...(nonce !== undefined ? { nonce: tamper?.nonce ?? nonce } : {}),
        ...(tamper?.omitClaims
          ? {}
          : {
              name: state.user.name,
              email: state.user.email,
              email_verified: state.user.email_verified
            })
      }
      const key = tamper?.key === 'other' ? keys.other : keys.signing
      const id_token = signJwt(
        key,
        claims,
        tamper?.key === 'other' ? { kid: keys.signing.kid } : {}
      )
      const access_token = `at-${randomBytes(12).toString('hex')}`
      const bare = grant === 'refresh_token' && state.bareRefresh
      const response = {
        access_token,
        token_type: 'Bearer',
        scope,
        ...(bare ? {} : { expires_in: state.accessTokenTtlSec, id_token })
      }
      if (
        state.issueRefresh &&
        scope.split(' ').includes('offline_access') &&
        !tamper?.omitRefresh
      ) {
        const refresh_token = `rt-${randomBytes(12).toString('hex')}`
        state.refreshTokens.set(refresh_token, { sub: claims.sub, client_id, scope })
        response.refresh_token = refresh_token
      }
      return json(res, 200, response, { 'cache-control': 'no-store' })
    }

    if (url.pathname === '/userinfo') {
      state.counts.userinfo++
      if (state.userinfoFail) return json(res, 500, { error: 'server_error' })
      return json(res, 200, {
        sub: state.user.sub,
        name: state.user.name,
        email: state.user.email,
        email_verified: state.user.email_verified
      })
    }

    json(res, 404, { error: 'not_found' })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  issuer = `http://127.0.0.1:${port}`

  return {
    issuer,
    port,
    keys,
    state,
    /** Play the user's browser: open the authorization URL and follow the
     *  redirect to the client's loopback callback. Returns the callback's
     *  response. */
    async browse(authorizationUrl) {
      const first = await fetch(authorizationUrl, { redirect: 'manual' })
      if (first.status !== 302) {
        throw new Error(`authorize answered ${first.status}: ${await first.text()}`)
      }
      const location = first.headers.get('location')
      return { location, response: await fetch(location, { redirect: 'manual' }) }
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}
