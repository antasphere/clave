/**
 * The forward carrier (PRDCT-4473): a page a server serves on its own
 * loopback, framed on a Mac attached to that server over its one port. Two
 * hops carry it, a loopback listener in the Mac's main process and the
 * server's `/forward/<lease>/…` route inside its token check, and both read
 * the names below. Plain constants and helpers: no Effect, so the Mac's hop
 * imports them without loading the framework.
 */

/** `…/forward/<lease>/<rest>`: a request relayed to a loopback port the server registered. */
export const FORWARD_PATH = '/forward'

/** The page's Origin as the Mac's hop saw it: `self`, or the literal value. Never a page's own header. */
export const FORWARD_ORIGIN_HEADER = 'x-clave-forward-origin'
export const FORWARD_SELF_ORIGIN = 'self'

/** On an answer the server's hop wrote itself (no such lease, target gone): the Mac's hop tells it from the target's own answers. */
export const FORWARD_REFUSED_HEADER = 'x-clave-forward'
export const FORWARD_REFUSED = 'refused'

/** A lease: 32 lowercase hex characters. */
export const isForwardLease = (value: string): boolean => /^[0-9a-f]{32}$/.test(value)

/** Headers that belong to one connection and are never relayed (RFC 9110 §7.6.1). */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

/** The names an incoming `Connection` header lists: they are this hop's
 *  own as much as the fixed set above, and go no further. */
export const connectionListed = (value: string | string[] | undefined): Set<string> => {
  const listed = new Set<string>()
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value]
  for (const line of values)
    for (const name of line.split(',')) {
      const trimmed = name.trim().toLowerCase()
      if (trimmed) listed.add(trimmed)
    }
  return listed
}

/** The most a relayed WebSocket holds for a side that is not open yet. */
export const FORWARD_HOLD_LIMIT = 1024 * 1024

/**
 * The close code relayed to the other side of a WebSocket. Some codes only
 * describe a close and can never be sent in a close frame (1005 no status,
 * 1006 abnormal, 1015 TLS), and a few are reserved: those become a plain
 * 1000, so one side's end is always the other's end too.
 */
export const relayCloseCode = (code: number | undefined): number => {
  if (code === undefined) return 1000
  if (code >= 3000 && code <= 4999) return code
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code
  return 1000
}
