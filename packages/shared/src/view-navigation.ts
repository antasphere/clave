/**
 * Where a link followed inside a view goes.
 *
 * A view (a group's or a session's attached page, or an .html file opened as
 * a page) is an Electron web view with a history of its own. The page can
 * link anywhere; this is the one rule that decides whether a link stays in
 * the pane (and joins the trail the back and forward arrows walk) or leaves
 * for the system browser. It lives apart from the main-process wiring so
 * every outcome stays testable without a window:
 *
 *  - `in-pane`: the target is on the local machine (a loopback host — another
 *    exos page on another port, a sibling dev server), on the origin the view
 *    started on (an https dashboard navigating within itself), or, for a page
 *    served from disk, in the same folder as the page the view opened on (the
 *    `clave-preview` protocol scopes a file's token to its own directory, so
 *    "same token" IS "same folder"). Home is always one click away, so
 *    wandering here is safe.
 *  - `external`: any other http(s) URL. The pane is a place, not a browser;
 *    a link to the wider web opens where the user's bookmarks and sessions are,
 *    exactly as a popup from the page already does.
 *  - `deny`: anything else — a custom scheme, `file:`, `javascript:`, a
 *    `clave-preview` token that is not the view's own. Nothing in a view may
 *    reach the app's own protocols or the disk beyond its folder.
 */
export type NavigationDecision = 'in-pane' | 'external' | 'deny'

/**
 * The local machine, by ADDRESS, never by name shape. The URL parser hands us a
 * canonical hostname (`0x7f000001` and `2130706433` both arrive as
 * `127.0.0.1`, an IPv4-mapped IPv6 loopback as `[::ffff:7f00:1]`), so the
 * whole 127/8 block is one dotted-quad test. A public name that merely starts
 * with `127.` (`127.0.0.1.nip.io`, `127.example.com`) is NOT local: wildcard
 * DNS resolves it wherever its owner likes, and a string prefix would have let
 * it into the pane. `localhost` and its subdomains are loopback by RFC 6761.
 */
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const LOOPBACK_V6 = /^\[(?:::1|::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4})\]$/

/** The protocol that serves an .html file and its folder (packages/host/src/preview-protocol.ts). */
export const PREVIEW_PROTOCOL = 'clave-preview:'

const isHttp = (u: URL): boolean => u.protocol === 'http:' || u.protocol === 'https:'

/** Same scheme and same host (and port). Spelled out rather than `origin`:
 *  a custom scheme is "null" origin to a plain URL parser, and this file runs
 *  under one in the unit tests. For http(s) it is exactly the origin. */
const sameSite = (a: URL, b: URL): boolean => a.protocol === b.protocol && a.host === b.host

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '0.0.0.0' ||
    LOOPBACK_V4.test(h) ||
    LOOPBACK_V6.test(h)
  )
}

export function decideNavigation(home: string, target: string): NavigationDecision {
  let t: URL
  try {
    t = new URL(target)
  } catch {
    return 'deny'
  }
  let h: URL | null = null
  try {
    h = new URL(home)
  } catch {
    // an unparseable home only loses the same-site grants
  }
  if (t.protocol === PREVIEW_PROTOCOL) {
    return h && sameSite(h, t) ? 'in-pane' : 'deny'
  }
  if (!isHttp(t)) return 'deny'
  if (isLoopbackHost(t.hostname)) return 'in-pane'
  if (h && isHttp(h) && sameSite(h, t)) return 'in-pane'
  return 'external'
}

/**
 * Whether the page the view shows IS its home. A declared home is usually
 * written without a path (`http://127.0.0.1:4756`); the browser reports it as
 * `http://127.0.0.1:4756/`, and a page may add a hash of its own. Same site,
 * same path (a lone `/` counts as none), same query: home.
 */
export function isAtHome(home: string, current: string): boolean {
  try {
    const h = new URL(home)
    const c = new URL(current)
    const path = (u: URL): string => (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''))
    return sameSite(h, c) && path(h) === path(c) && h.search === c.search
  } catch {
    return false
  }
}
