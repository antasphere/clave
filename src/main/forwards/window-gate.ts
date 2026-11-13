/**
 * The window gate of the forward listeners (PRDCT-4473): every request a
 * Clave window (or a view guest inside one) makes to an open forward port
 * leaves with that port's secret in `x-clave-window`, added here by main,
 * where no page can read or forge it. A process on this Mac, or a page in a
 * browser, reaches the same port without it and is refused by the listener.
 *
 * Electron keeps ONE `onBeforeSendHeaders` listener per session, and a new
 * call silently replaces the one before. This module owns it for the sessions
 * it is given: nothing else in `src/main` uses `webRequest` today, and a
 * second user must come through here rather than install its own.
 */
import type { Session } from 'electron'
import { WINDOW_HEADER, type LoopbackForwards } from './loopback-forwards'

/** The URL patterns of the open ports, both loopback names, HTTP and WebSocket. */
export const gateUrls = (secrets: ReadonlyMap<number, string>): string[] => {
  const urls: string[] = []
  for (const port of secrets.keys())
    urls.push(
      `http://127.0.0.1:${port}/*`,
      `ws://127.0.0.1:${port}/*`,
      `http://localhost:${port}/*`,
      `ws://localhost:${port}/*`
    )
  return urls
}

const OWN_PORT = /^(?:http|ws):\/\/(?:127\.0\.0\.1|localhost):(\d+)\//i

/**
 * The headers a request leaves with: the port's secret on a request to an
 * open port, put in place of any header of that name the page set itself
 * (whatever its case); the headers untouched otherwise.
 */
export const stampWindowHeader = (
  url: string,
  headers: Record<string, string>,
  secrets: ReadonlyMap<number, string>
): Record<string, string> => {
  const match = OWN_PORT.exec(url)
  const secret = match ? secrets.get(Number(match[1])) : undefined
  if (secret === undefined) return headers
  const stamped: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers))
    if (name.toLowerCase() !== WINDOW_HEADER) stamped[name] = value
  stamped[WINDOW_HEADER] = secret
  return stamped
}

/** Keep each session's listener in step with the open ports. Returns the uninstall. */
export function installWindowGate(
  forwards: LoopbackForwards,
  sessions: () => Session[]
): () => void {
  const apply = (): void => {
    const secrets = forwards.secrets()
    for (const session of sessions()) {
      if (secrets.size === 0) {
        session.webRequest.onBeforeSendHeaders(null)
        continue
      }
      session.webRequest.onBeforeSendHeaders({ urls: gateUrls(secrets) }, (details, callback) => {
        callback({
          requestHeaders: stampWindowHeader(details.url, details.requestHeaders, forwards.secrets())
        })
      })
    }
  }
  apply()
  const off = forwards.onChange(apply)
  return () => {
    off()
    for (const session of sessions()) session.webRequest.onBeforeSendHeaders(null)
  }
}
