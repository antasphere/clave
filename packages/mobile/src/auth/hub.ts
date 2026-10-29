/**
 * The phone's client of the hub's OAuth surface, over the platform's
 * `fetch` (lane C's `FetchLike`, so a test hands it a stub or Node's own):
 * discovery, the dynamic registration of the app as an anonymous public
 * native client, the authorization URL, the code exchange and the refresh
 * grant. Every request is pinned to the issuer's origin and waits at most
 * 15 s, the Mac's two bounds (`src/main/antasphere-account.ts`). The
 * registration is the Mac's with the phone's redirect: `type: native` (the
 * hub's own field, the audit of 29 October 2026) beside `application_type:
 * native` (RFC 7591, what the local provider echoes), the redirect
 * `clave://oauth/callback`, the scopes openid profile email offline_access,
 * the grants authorization_code and refresh_token, `token_endpoint_auth_method:
 * none`; a registration that comes back confidential or without the code
 * grant is refused and nothing is kept. The hub answers 200 where RFC 7591
 * says 201: both are a registration.
 */
import type { FetchLike } from '../api/client'
import { CLIENT_NAME, REDIRECT_URI, SCOPE, type IssuerConfig } from './issuer'

export type HubFailure =
  | 'network'
  | 'timeout'
  | 'invalid-response'
  | 'registration'
  | 'invalid_grant'
  | 'invalid_client'

export class HubError extends Error {
  constructor(
    readonly kind: HubFailure,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'HubError'
  }
}

export interface HubMetadata {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly registrationEndpoint: string | null
  readonly jwksUri: string
  readonly userinfoEndpoint: string | null
}

export interface TokenResponse {
  readonly accessToken: string
  readonly tokenType: string
  /** Seconds, when the hub states one. */
  readonly expiresIn: number | null
  readonly idToken: string | null
  readonly refreshToken: string | null
  readonly scope: string | null
}

export interface HubClientOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
}

export const REQUEST_TIMEOUT_MS = 15_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const defaultFetch = (): FetchLike => {
  const f = (globalThis as { fetch?: unknown }).fetch
  if (typeof f !== 'function')
    throw new Error('No fetch in this environment: pass one in the options')
  return f as FetchLike
}

export class HubClient {
  private readonly fetch: FetchLike
  private readonly timeoutMs: number
  private metadataCache: HubMetadata | null = null

  constructor(
    readonly issuer: IssuerConfig,
    options: HubClientOptions = {}
  ) {
    this.fetch = options.fetch ?? defaultFetch()
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  /** The discovery document, read once; every endpoint must sit on the
   *  issuer's origin or the metadata is refused before the browser is sent
   *  anywhere. */
  async metadata(): Promise<HubMetadata> {
    if (this.metadataCache) return this.metadataCache
    const { status, json } = await this.request(
      'GET',
      `${this.issuer.origin}/.well-known/openid-configuration`
    )
    if (status !== 200 || !isRecord(json))
      throw new HubError('invalid-response', 'The issuer served no discovery document.', status)
    if (json.issuer !== this.issuer.origin)
      throw new HubError('invalid-response', 'The metadata names another issuer.')
    const endpoint = (key: string, required: boolean): string | null => {
      const value = json[key]
      if (value === undefined) {
        if (required) throw new HubError('invalid-response', `${key} is missing.`)
        return null
      }
      if (typeof value !== 'string' || !this.onIssuer(value))
        throw new HubError('invalid-response', `${key} is off the issuer.`)
      return value
    }
    this.metadataCache = {
      issuer: this.issuer.origin,
      authorizationEndpoint: endpoint('authorization_endpoint', true)!,
      tokenEndpoint: endpoint('token_endpoint', true)!,
      jwksUri: endpoint('jwks_uri', true)!,
      registrationEndpoint: endpoint('registration_endpoint', false),
      userinfoEndpoint: endpoint('userinfo_endpoint', false)
    }
    return this.metadataCache
  }

  /** Registers the app; answers the client id. */
  async register(): Promise<string> {
    const metadata = await this.metadata()
    if (!metadata.registrationEndpoint)
      throw new HubError('registration', 'The issuer registers no clients.')
    const body = JSON.stringify({
      client_name: CLIENT_NAME,
      type: 'native',
      application_type: 'native',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE
    })
    const { status, json } = await this.request('POST', metadata.registrationEndpoint, {
      body,
      contentType: 'application/json'
    })
    if (status !== 200 && status !== 201)
      throw new HubError('registration', 'The issuer refused the registration.', status)
    if (!isRecord(json) || typeof json.client_id !== 'string' || !json.client_id)
      throw new HubError('registration', 'The registration answered no client id.', status)
    if (
      json.client_secret !== undefined ||
      (json.token_endpoint_auth_method !== undefined && json.token_endpoint_auth_method !== 'none')
    )
      throw new HubError('registration', 'The issuer registered a confidential client.', status)
    const grants = json.grant_types
    if (!Array.isArray(grants) || !grants.includes('authorization_code'))
      throw new HubError('registration', 'The registration lacks the code grant.', status)
    return json.client_id
  }

  async authorizationUrl(input: {
    readonly clientId: string
    readonly codeChallenge: string
    readonly state: string
    readonly nonce: string
  }): Promise<string> {
    const metadata = await this.metadata()
    const url = new URL(metadata.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', input.clientId)
    url.searchParams.set('redirect_uri', REDIRECT_URI)
    url.searchParams.set('scope', SCOPE)
    url.searchParams.set('code_challenge', input.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', input.state)
    url.searchParams.set('nonce', input.nonce)
    return url.toString()
  }

  exchangeCode(input: {
    readonly clientId: string
    readonly code: string
    readonly verifier: string
  }): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: input.verifier
    })
  }

  refresh(input: {
    readonly clientId: string
    readonly refreshToken: string
  }): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      client_id: input.clientId,
      refresh_token: input.refreshToken
    })
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
    const metadata = await this.metadata()
    const { status, json } = await this.request('POST', metadata.tokenEndpoint, {
      body: new URLSearchParams(form).toString(),
      contentType: 'application/x-www-form-urlencoded'
    })
    if (status < 200 || status >= 300) {
      const error = isRecord(json) && typeof json.error === 'string' ? json.error : ''
      if (error === 'invalid_grant')
        throw new HubError('invalid_grant', 'The issuer refused the grant.', status)
      if (error === 'invalid_client')
        throw new HubError('invalid_client', 'The issuer no longer knows this client.', status)
      throw new HubError(
        'invalid-response',
        `The token endpoint answered ${status}${error ? ` (${error})` : ''}.`,
        status
      )
    }
    if (!isRecord(json) || typeof json.access_token !== 'string' || !json.access_token)
      throw new HubError('invalid-response', 'The token endpoint answered no access token.', status)
    const optionalString = (value: unknown): string | null =>
      typeof value === 'string' && value ? value : null
    return {
      accessToken: json.access_token,
      tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
      expiresIn:
        typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)
          ? json.expires_in
          : null,
      idToken: optionalString(json.id_token),
      refreshToken: optionalString(json.refresh_token),
      scope: optionalString(json.scope)
    }
  }

  private onIssuer(url: string): boolean {
    try {
      return new URL(url).origin === this.issuer.origin
    } catch {
      return false
    }
  }

  private async request(
    method: 'GET' | 'POST',
    url: string,
    options: { readonly body?: string; readonly contentType?: string } = {}
  ): Promise<{ status: number; json: unknown }> {
    if (!this.onIssuer(url))
      throw new HubError('invalid-response', 'A request would leave the issuer.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let status: number
    let text: string
    try {
      const response = await this.fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(options.contentType ? { 'Content-Type': options.contentType } : {})
        },
        ...(options.body !== undefined ? { body: options.body } : {}),
        signal: controller.signal
      })
      status = response.status
      text = await response.text()
    } catch {
      if (controller.signal.aborted)
        throw new HubError(
          'timeout',
          `The issuer did not answer within ${this.timeoutMs / 1000} s.`
        )
      throw new HubError('network', 'The issuer could not be reached.')
    } finally {
      clearTimeout(timer)
    }
    let json: unknown = undefined
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }
    return { status, json }
  }
}
