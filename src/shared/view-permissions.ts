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
 * IPv6 loopback keeps its brackets in `URL.hostname` (`http://[::1]:4796` has
 * hostname `[::1]`, and a bare `http://::1` does not parse at all), so the
 * bracketed spelling is the only one that can ever match. `0.0.0.0` is
 * deliberately absent: a server bound to it answers the whole network, so it
 * is not a page only this machine can reach.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

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

/** What the caller knows about the frame that is asking. */
export interface ViewPermissionAsk {
  /** The origin doing the asking (a frame's own, which may be a subframe's). */
  origin: string
  /**
   * What is being asked for. The request handler passes the whole list, the
   * check handler its single type, and an absent list refuses. Every type
   * asked for must be allowed — asking for the microphone AND the camera is
   * asking for the camera too.
   */
  mediaTypes: readonly string[] | undefined
  /** Is the asking frame the page itself, rather than something it embeds? */
  isMainFrame: boolean
}

/**
 * The view partition's rule, in one place for both the request handler and the
 * check handler: they must agree, or a page is granted the microphone and then
 * told by `navigator.permissions.query` that it does not have it.
 *
 * The frame matters as much as the origin, and this is the part that is easy
 * to get wrong. A page from the internet shown in a view can embed
 * `<iframe src="http://127.0.0.1:1234">` and ask through it: the asking origin
 * is then the iframe's, which is loopback, while the page driving it is not.
 * An iframe is a subresource load rather than a navigation, so the link policy
 * never sees it.
 *
 * Only the MAIN frame is granted. Reasoning about the embedder was tried and
 * dropped: the request handler is given `isMainFrame` and nothing else (no
 * embedding origin at all), the check handler's `embeddingOrigin` names only
 * the immediate parent and only when it is cross-origin, so a nesting three
 * deep cannot be placed from it. A page that wants the microphone is a page
 * Clave shows, not something one of them embeds.
 */
export function allowsViewPermission(ask: ViewPermissionAsk, permission: string): boolean {
  if (!LOCAL_PERMISSIONS.has(permission)) return false
  // A media request that names no type is refused: `getUserMedia({audio:true})`
  // always names one, so an empty list is not the voice dock asking.
  if (!ask.mediaTypes || ask.mediaTypes.length === 0) return false
  if (!ask.mediaTypes.every((type) => ALLOWED_MEDIA_TYPES.has(type))) return false
  if (!ask.isMainFrame) return false
  return isLocalPageOrigin(ask.origin)
}
