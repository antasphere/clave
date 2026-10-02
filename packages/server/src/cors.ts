/**
 * The browser side of the token check. A page served from a loopback origin
 * (the renderer under `npm run dev` on `http://localhost:5173`, a browser
 * client later) sends a preflight before any request with an Authorization
 * header, and a preflight carries no token by definition. So the preflight
 * is answered here, before the token check, for loopback origins only, and
 * every response to such an origin says it may be read. Any other origin is
 * a stranger: no preflight answer, no header, the request itself still
 * meets the token check behind this.
 */
import { Effect } from 'effect'
import * as HttpApp from '@effect/platform/HttpApp'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import type { Wrap } from './auth'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A page on this machine: `http(s)://localhost:*`, `127.0.0.1:*`, `[::1]:*`,
 *  the hostname whole (a lookalike such as `localhost.evil.com` is not one). */
export const isLoopbackOrigin = (origin: string | undefined): boolean => {
  if (!origin) return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)
}

/** The packaged renderer is a `file://` page; Chromium names its origin
 *  `file://` on a WebSocket handshake and `null` where the origin is opaque.
 *  Such a page is this machine's own as much as a loopback one; the token in
 *  the hello is what proves the client, the origin only keeps a page off this
 *  machine from trying. */
export const isOwnPageOrigin = (origin: string | undefined): boolean =>
  origin === 'file://' || origin === 'null' || isLoopbackOrigin(origin)

const ALLOW_METHODS = 'GET, POST, OPTIONS'
/** What the typed client sends with every request, besides what a browser
 *  adds on its own: the token, the JSON body, the framework's idempotency and
 *  correlation headers, and the tracing headers the Effect HTTP client
 *  propagates (`traceparent`, `b3`). A preflight that names more is answered
 *  with what it named: the request behind it still meets the token check. */
const ALLOW_HEADERS =
  'authorization, content-type, x-idempotency-key, x-correlation-id, x-request-id, traceparent, tracestate, b3'

export const corsForLoopback: Wrap = <E, R>(app: HttpApp.Default<E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const origin = request.headers['origin']
    if (!isLoopbackOrigin(origin)) return yield* app
    const allow = {
      'access-control-allow-origin': origin as string,
      vary: 'Origin'
    }
    if (request.method === 'OPTIONS') {
      return HttpServerResponse.empty({
        status: 204,
        headers: {
          ...allow,
          'access-control-allow-methods': ALLOW_METHODS,
          'access-control-allow-headers':
            request.headers['access-control-request-headers'] ?? ALLOW_HEADERS,
          'access-control-max-age': '600'
        }
      })
    }
    // The router's responses do not all come back through this effect's
    // success channel (the platform's own middleware stamps its headers the
    // same way), so the header is set on whatever response the request ends
    // with, by the pre-response hook.
    yield* HttpApp.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeaders(response, allow))
    )
    return yield* app
  })
