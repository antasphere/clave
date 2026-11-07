/**
 * Where a credential may travel (decision 4 of the spec, the rule of 29
 * October 2026): the relay over HTTPS is the road, and a direct address is
 * used only over https with a certificate the platform validates. A release
 * build never sends a device session, or any credential, to a plain-HTTP
 * address, and ignores such addresses entirely: out in town, a private
 * address on a public network can name someone else's machine. Plain HTTP
 * to the loopback stays in the developer connection of development builds,
 * where a standalone server on this very machine is the point.
 */
export type BuildKind = 'development' | 'release'

export type TransportVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export const isLoopbackHost = (hostname: string): boolean =>
  LOOPBACK_HOSTS.has(hostname.toLowerCase())

/** Whether a credential may be sent to `url` (http(s) or ws(s)) in this build. */
export function credentialMayTravelTo(url: string, build: BuildKind): TransportVerdict {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: `"${url}" is not an address.` }
  }
  const scheme = parsed.protocol
  if (scheme === 'https:' || scheme === 'wss:') return { ok: true }
  if (scheme === 'http:' || scheme === 'ws:') {
    if (build === 'development' && isLoopbackHost(parsed.hostname)) return { ok: true }
    return {
      ok: false,
      reason:
        build === 'development'
          ? `Plain ${scheme.slice(0, -1)} is allowed to 127.0.0.1 only in a development build; use https for ${parsed.host}.`
          : `A credential never travels over plain ${scheme.slice(0, -1)} (${parsed.host}); only https is used.`
    }
  }
  return { ok: false, reason: `"${scheme}" is not a scheme a credential travels over.` }
}

/** The same verdict as a thrown error, for a constructor. */
export function assertCredentialMayTravelTo(url: string, build: BuildKind): void {
  const verdict = credentialMayTravelTo(url, build)
  if (!verdict.ok) throw new TransportPolicyError(verdict.reason, url)
}

export class TransportPolicyError extends Error {
  constructor(
    message: string,
    readonly url: string
  ) {
    super(message)
    this.name = 'TransportPolicyError'
  }
}
