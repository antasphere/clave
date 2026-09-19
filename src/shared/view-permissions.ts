/**
 * What a page shown in a Clave view is allowed to ask for.
 *
 * Guest pages run in one hardened session that answered no to everything, on
 * the principle that a dashboard has no business asking. The microphone is the
 * one exception, and only for the pages Clave itself serves from this machine:
 * an Exos board, a workstream page, a dev server, the Exos voice dock. Those
 * are local ports the person started; the rest of the web keeps the refusal.
 *
 * Pure and unit-tested, because the cost of an error here is silent: a rule
 * that is too loose grants a microphone to a page nobody vetted, and nothing
 * in the app looks any different.
 */

/** The permissions a local page may be granted. Everything else is refused. */
const LOCAL_PERMISSIONS = new Set(['media'])

/**
 * `media` covers the microphone AND the camera, under one permission name. The
 * grant is the microphone's alone, so the media type is checked too: `audio`
 * passes, `video` is refused, and `unknown` is refused because a request that
 * will not say what it wants is not a request for the microphone.
 *
 * A request carries the types it asks for as a list (`mediaTypes`); a check
 * carries the single one it is checking (`mediaType`). Both arrive here.
 */
const ALLOWED_MEDIA_TYPES = new Set(['audio'])

/**
 * The loopback hosts, exactly. Not a prefix test: `127.0.0.1.evil.com` and
 * `localhost.evil.com` are ordinary internet hosts that a `startsWith` or a
 * substring check would hand the microphone to.
 *
 * IPv6 loopback is spelled `[::1]` in a URL's host, and `URL.hostname` strips
 * the brackets, so both spellings are listed.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Is this a page Clave served from this machine over plain HTTP?
 *
 * `http:` and `https:` only: a `file://` page has the opaque origin `null`,
 * and any custom scheme (`clave-preview://`, which serves a folder off disk)
 * is deliberately excluded — those carry no port and no host to reason about,
 * so "local" would mean "any file the page can reach".
 */
export function isLocalPageOrigin(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return LOOPBACK_HOSTS.has(parsed.hostname)
}

/**
 * The view partition's rule, in one place for both the request handler and the
 * check handler: they must agree, or a page is granted the microphone and then
 * told by `navigator.permissions.query` that it does not have it.
 *
 * `mediaTypes` is what the caller knows about what is being asked for: the
 * request handler passes the whole list, the check handler its single type,
 * and an absent list refuses. Every type asked for must be allowed — a request
 * for the microphone AND the camera is a request for the camera too.
 */
export function allowsViewPermission(
  url: string,
  permission: string,
  mediaTypes: readonly string[] | undefined
): boolean {
  if (!LOCAL_PERMISSIONS.has(permission)) return false
  // A media request that names no type is refused: `getUserMedia({audio:true})`
  // always names one, so an empty list is not the voice dock asking.
  if (!mediaTypes || mediaTypes.length === 0) return false
  if (!mediaTypes.every((type) => ALLOWED_MEDIA_TYPES.has(type))) return false
  return isLocalPageOrigin(url)
}
