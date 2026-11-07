/**
 * The issuer the phone signs in at: the hub, or the loopback provider named
 * for a test (decision 2 of the spec). The rule is the Mac's
 * (`src/main/antasphere-account.ts`, `resolveAntasphereIssuer`): an override
 * is a bare origin, https, or plain http to the literal `127.0.0.1` and
 * nothing else, and a refused override does NOT fall back to the hub: a
 * build told to use a test provider must never reach production because the
 * value had a typo. The Android emulator reaches a provider on the Mac's
 * loopback through `adb reverse tcp:<port> tcp:<port>` (docs/mobile-beta.md).
 *
 * The scopes, the grants and the redirect are fixed here, as on the Mac:
 * the identity and the one scope that renews it, nothing of the hub's own
 * scopes; the custom scheme the hub's consent page accepts (a host that is
 * not empty: `oauth`), registered by lane C's app.json (`scheme: clave`).
 */
export const DEFAULT_ISSUER = 'https://account.antasphere.com'
/** Legacy build-time app.config override. Metro uses EXPO_PUBLIC_CLAVE_ANTASPHERE_ISSUER. */
export const ISSUER_ENV = 'CLAVE_ANTASPHERE_ISSUER'
export const SCOPE = 'openid profile email offline_access'
export const REDIRECT_URI = 'clave://oauth/callback'
export const CLIENT_NAME = 'Clave'

export interface IssuerConfig {
  /** The issuer's origin, no trailing slash: `https://account.antasphere.com`. */
  readonly origin: string
  /** Plain HTTP, allowed for the literal loopback test target and nothing else. */
  readonly insecure: boolean
}

export type IssuerResolution =
  | { readonly ok: true; readonly config: IssuerConfig }
  | { readonly ok: false; readonly reason: string }

export function resolveIssuer(raw: string | null | undefined): IssuerResolution {
  const trimmed = raw?.trim()
  if (!trimmed) return { ok: true, config: { origin: DEFAULT_ISSUER, insecure: false } }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'not a URL' }
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    return { ok: false, reason: 'not a bare origin' }
  if (url.protocol === 'https:')
    return { ok: true, config: { origin: url.origin, insecure: false } }
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1')
    return { ok: true, config: { origin: url.origin, insecure: true } }
  return { ok: false, reason: 'plain http is only accepted for 127.0.0.1' }
}
