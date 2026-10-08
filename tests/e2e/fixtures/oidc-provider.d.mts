/** Types for the local OIDC provider (`oidc-provider.mjs`), for the vitest suite. */
export interface OidcProviderUser {
  sub: string
  name: string
  email: string
  email_verified: boolean
}

export interface OidcProviderTamper {
  key?: 'other'
  iss?: string
  aud?: string
  nonce?: string
  exp?: number
  sub?: string
  omitRefresh?: boolean
  omitClaims?: boolean
}

export interface OidcProviderState {
  user: OidcProviderUser
  issueRefresh: boolean
  idTokenTtlSec: number
  accessTokenTtlSec: number
  log: Array<{ method: string; path: string; body: string }>
  registrations: Array<{ sent: Record<string, unknown>; registered: Record<string, unknown> }>
  codes: Map<
    string,
    { client_id: string; redirect_uri: string; scope: string; nonce: string; used: boolean }
  >
  refreshTokens: Map<string, { sub: string; client_id: string; scope: string }>
  tamper: OidcProviderTamper | null
  denyNext: boolean
  tokenDelayMs: number
  refreshDelayMs: number
  discoveryDelayMs: number
  registerDelayOnceMs: number
  foreignTokenEndpoint: string | null
  discoveryPadBytes: number
  refuseRegistrationOnce: number | null
  confidentialNext: boolean
  bareRefresh: boolean
  userinfoFail: boolean
  grantTypesOverride: string[] | null
  counts: {
    discovery: number
    register: number
    authorize: number
    token: number
    refresh: number
    jwks: number
    userinfo: number
  }
}

export interface OidcProvider {
  issuer: string
  port: number
  state: OidcProviderState
  browse(authorizationUrl: URL | string): Promise<{ location: string; response: Response }>
  close(): Promise<void>
}

export function startOidcProvider(options?: {
  user?: OidcProviderUser
  issueRefresh?: boolean
  idTokenTtlSec?: number
  accessTokenTtlSec?: number
}): Promise<OidcProvider>
