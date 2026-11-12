/**
 * The server's hop of the forward carrier (PRDCT-4473): `/forward/<lease>/…`
 * relays a request to a page this server serves on its own loopback, the
 * port registered under the lease (`registry.ts`). It sits INSIDE the token
 * check, so only a caller holding this server's token reaches any page, and
 * the lease names a port on `127.0.0.1` and nothing else.
 *
 * The page answers only its own `Host` and trusts only its own `Origin`, so
 * both are rewritten here, the way the page would see them if it were opened
 * on this machine: `Host` always, `Origin` only as the Mac's hop reports it
 * in `x-clave-forward-origin` (the page's own origin as `self`, a stranger's
 * as it was). Credentials stop here: the bearer and any cookie are never
 * relayed, and the page's `set-cookie` never leaves.
 *
 * The path is carried as it was received, never decoded or normalised: the
 * page decides what `/a/../b` means, and the server's own API is never
 * reached by one, whatever it holds. Bodies go up and answers come down as
 * streams, so an event stream is relayed chunk by chunk and a large upload
 * is never collected in memory. `node:http` (and `ws` for an upgrade) runs
 * under Node and under Bun alike; `fetch` would buffer neither way.
 */
import http from 'node:http'
import { Effect, Either, Runtime, Stream } from 'effect'
import * as Socket from '@effect/platform/Socket'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import { WebSocket, type RawData } from 'ws'
import {
  FORWARD_HOLD_LIMIT,
  FORWARD_ORIGIN_HEADER,
  FORWARD_PATH,
  FORWARD_REFUSED,
  FORWARD_REFUSED_HEADER,
  FORWARD_SELF_ORIGIN,
  HOP_BY_HOP_HEADERS,
  connectionListed,
  relayCloseCode
} from '@clave/contract/forward'
import { type Wrap, pathOf } from '../auth'
import type { ForwardRegistry } from './registry'

/** How long the page has to answer with its headers. */
export const FORWARD_HEADERS_TIMEOUT_MS = 30_000

/** The raw request line's target: the lease, then the rest exactly as sent. */
const FORWARD_URL = /^\/forward\/([0-9a-f]{32})([/?][^]*)?$/

/** The names a request to the page never carries: the hop's own, and the
 *  credentials and identity this server checked or will set itself. */
const DROPPED_UP = new Set(['authorization', 'cookie', 'host', 'origin', FORWARD_ORIGIN_HEADER])

const refused = (
  status: number,
  error: 'UnknownForward' | 'ForwardTargetGone' | 'ForwardTargetSilent',
  message: string
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.unsafeJson(
    { error, message },
    { status, headers: { [FORWARD_REFUSED_HEADER]: FORWARD_REFUSED } }
  )

const unknownForward = (): HttpServerResponse.HttpServerResponse =>
  refused(404, 'UnknownForward', 'This server forwards no such page.')
const targetGone = (): HttpServerResponse.HttpServerResponse =>
  refused(502, 'ForwardTargetGone', 'The page this server forwards is not answering.')
const targetSilent = (): HttpServerResponse.HttpServerResponse =>
  refused(504, 'ForwardTargetSilent', 'The page this server forwards is not answering.')

type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>

/** The headers of a request as the page should receive them. */
export const upstreamHeaders = (incoming: HeaderBag, port: number): Record<string, string> => {
  const listed = connectionListed(incoming['connection'] as string | string[] | undefined)
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase()
    if (value === undefined) continue
    if (HOP_BY_HOP_HEADERS.has(lower) || listed.has(lower) || DROPPED_UP.has(lower)) continue
    out[lower] = Array.isArray(value) ? value.join(', ') : (value as string)
  }
  out['host'] = `127.0.0.1:${port}`
  const origin = targetOrigin(incoming[FORWARD_ORIGIN_HEADER], port)
  if (origin !== undefined) out['origin'] = origin
  return out
}

/** The Origin the page sees: its own for `self`, a stranger's as it was,
 *  none when the Mac's hop reported none. */
const targetOrigin = (
  reported: string | readonly string[] | undefined,
  port: number
): string | undefined => {
  if (reported === undefined) return undefined
  const value = Array.isArray(reported) ? reported.join(', ') : (reported as string)
  return value === FORWARD_SELF_ORIGIN ? `http://127.0.0.1:${port}` : value
}

/** The headers of the page's answer as the caller receives them. */
const downstreamHeaders = (incoming: http.IncomingHttpHeaders): Record<string, string> => {
  const listed = connectionListed(incoming['connection'])
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    if (HOP_BY_HOP_HEADERS.has(name) || listed.has(name) || name === 'set-cookie') continue
    // Only this hop says `refused`: a page that set the header itself would
    // have the Mac's hop read its answer as this server's refusal.
    if (name === FORWARD_REFUSED_HEADER) continue
    out[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

const isUpgrade = (request: HttpServerRequest.HttpServerRequest): boolean =>
  (request.headers['upgrade'] ?? '').toLowerCase() === 'websocket'

export const forwardRoute =
  (registry: ForwardRegistry | undefined): Wrap =>
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = pathOf(request.url)
      if (path !== FORWARD_PATH && !path.startsWith(`${FORWARD_PATH}/`)) return yield* app
      // The RAW request target, never through `new URL`: a `..` or an
      // encoded slash is the page's to read, and must not be resolved here.
      const match = FORWARD_URL.exec(request.url)
      const target = match && registry ? registry.resolve(match[1]!) : undefined
      if (!match || !target) return unknownForward()
      const tail = match[2] ?? '/'
      const rest = tail.startsWith('?') ? `/${tail}` : tail
      if (isUpgrade(request)) return yield* relaySocket(request, target.port, rest)
      return yield* relayHttp(request, target.port, rest)
    })

/** One request to the page, its answer streamed back as it comes. */
const relayHttp = (
  request: HttpServerRequest.HttpServerRequest,
  port: number,
  rest: string
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.flatMap(Effect.runtime<never>(), (runtime) =>
    Effect.async<HttpServerResponse.HttpServerResponse>((resume) => {
      const build = (): http.ClientRequest | undefined => {
        try {
          return http.request({
            host: '127.0.0.1',
            port,
            method: request.method,
            path: rest,
            headers: upstreamHeaders(request.headers, port),
            // One connection per request: an answer abandoned half-way is
            // destroyed, and a pooled socket would carry its remains.
            agent: false
          })
        } catch {
          // A request `node:http` refuses to build. The listener answers 400
          // to such a request line before this route, so this is a last guard.
          return undefined
        }
      }
      const upstream = build()
      if (!upstream) {
        resume(Effect.succeed(targetGone()))
        return
      }
      let settled = false
      const timer = setTimeout(() => {
        settle(targetSilent())
        upstream.destroy()
      }, FORWARD_HEADERS_TIMEOUT_MS)
      const settle = (response: HttpServerResponse.HttpServerResponse): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resume(Effect.succeed(response))
      }
      upstream.setNoDelay(true)

      upstream.on('error', () => settle(targetGone()))
      upstream.on('response', (answer) => {
        const headers = downstreamHeaders(answer.headers)
        const status = answer.statusCode ?? 502
        if (request.method === 'HEAD' || status === 204 || status === 304) {
          answer.resume()
          settle(HttpServerResponse.empty({ status, headers }))
          return
        }
        const length = Number(answer.headers['content-length'])
        const body = Stream.fromAsyncIterable(answer as AsyncIterable<Uint8Array>, (e) => e).pipe(
          // The caller left (the platform interrupts the answer) or the page
          // broke off: the request to the page goes too, never left open.
          Stream.ensuring(
            Effect.sync(() => {
              if (!answer.complete) upstream.destroy()
            })
          )
        )
        settle(
          HttpServerResponse.stream(body, {
            status,
            headers,
            ...(Number.isFinite(length) && length > 0 && { contentLength: length })
          })
        )
      })

      // The body goes up as a stream, back-pressured, on a fiber of its own:
      // the answer may come back before the body is all sent.
      if (request.method === 'GET' || request.method === 'HEAD') upstream.end()
      else {
        const pump = Runtime.runFork(runtime)(
          Stream.runForEach(request.stream, (chunk) =>
            Effect.async<void>((done) => {
              if (upstream.destroyed) return done(Effect.void)
              if (upstream.write(chunk)) return done(Effect.void)
              const resumeOnce = (): void => {
                upstream.off('drain', resumeOnce)
                upstream.off('close', resumeOnce)
                done(Effect.void)
              }
              upstream.on('drain', resumeOnce)
              upstream.on('close', resumeOnce)
            })
          ).pipe(
            Effect.matchCause({
              onSuccess: () => {
                if (!upstream.destroyed) upstream.end()
              },
              onFailure: () => upstream.destroy()
            })
          )
        )
        upstream.on('close', () => Runtime.runFork(runtime)(pump.interruptAsFork(pump.id())))
      }

      // The caller went away before the page answered.
      return Effect.sync(() => {
        clearTimeout(timer)
        upstream.destroy()
      })
    })
  )

const asBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer)

/**
 * The WebSocket relay. The page's socket is opened FIRST, and the caller's
 * handshake taken only once it is open, so a page that refuses is still an
 * HTTP answer (502) rather than a socket that opens and dies.
 */
const relaySocket = (
  request: HttpServerRequest.HttpServerRequest,
  port: number,
  rest: string
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const offered = (request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    const origin = targetOrigin(request.headers[FORWARD_ORIGIN_HEADER], port)
    const target = new WebSocket(`ws://127.0.0.1:${port}${rest}`, offered, {
      perMessageDeflate: false,
      // A page that takes the connection and never answers the handshake.
      handshakeTimeout: FORWARD_HEADERS_TIMEOUT_MS,
      ...(origin !== undefined && { origin })
    })
    // What the page sends before the caller's side is open is held, within
    // a bound: the page cannot make this server keep an unbounded backlog.
    let held: Array<string | Buffer> = []
    let heldBytes = 0
    let overflow = false
    const onEarly = (data: RawData, isBinary: boolean): void => {
      const frame = isBinary ? asBuffer(data) : asBuffer(data).toString('utf8')
      heldBytes += typeof frame === 'string' ? Buffer.byteLength(frame) : frame.length
      if (heldBytes > FORWARD_HOLD_LIMIT) overflow = true
      else held.push(frame)
    }
    const opened = yield* Effect.async<boolean>((resume) => {
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        resume(Effect.succeed(ok))
      }
      target.once('open', () => {
        target.on('message', onEarly)
        finish(true)
      })
      target.once('unexpected-response', (req, res) => {
        res.resume()
        req.destroy()
        finish(false)
      })
      target.on('error', () => finish(false))
      return Effect.sync(() => target.terminate())
    })
    if (!opened) {
      target.terminate()
      return targetGone()
    }

    const upgraded = yield* Effect.either(HttpServerRequest.upgrade)
    if (Either.isLeft(upgraded)) {
      target.close(1011)
      return HttpServerResponse.text('A forwarded socket is a WebSocket.', { status: 426 })
    }
    const socket = upgraded.right
    yield* Effect.scoped(
      Effect.gen(function* () {
        const write = yield* socket.writer
        const runtime = yield* Effect.runtime<never>()
        const send = (chunk: string | Uint8Array | Socket.CloseEvent): void => {
          Runtime.runFork(runtime)(Effect.ignore(write(chunk)))
        }
        let ready = false
        target.off('message', onEarly)
        target.on('message', (data, isBinary) => {
          if (!ready) return onEarly(data, isBinary)
          send(isBinary ? asBuffer(data) : asBuffer(data).toString('utf8'))
        })
        target.on('close', (code, reason) => {
          send(new Socket.CloseEvent(relayCloseCode(code), reason.toString('utf8')))
        })
        target.on('error', () => send(new Socket.CloseEvent(1011, '')))
        const outcome = yield* Effect.either(
          socket.runRaw(
            (data) => {
              if (target.readyState === WebSocket.OPEN)
                target.send(data, { binary: typeof data !== 'string' })
            },
            {
              onOpen: Effect.sync(() => {
                ready = true
                if (overflow) {
                  send(new Socket.CloseEvent(1009, ''))
                  target.close(1009)
                } else for (const frame of held) send(frame)
                held = []
                heldBytes = 0
              })
            }
          )
        )
        // The caller's side ended: the page's goes with the same code.
        if (target.readyState === WebSocket.OPEN || target.readyState === WebSocket.CONNECTING) {
          if (Either.isRight(outcome)) target.close(1000)
          else if (Socket.SocketCloseError.is(outcome.left))
            target.close(relayCloseCode(outcome.left.code), outcome.left.closeReason ?? '')
          else target.close(1011)
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (target.readyState === WebSocket.CONNECTING) target.terminate()
            else if (target.readyState === WebSocket.OPEN) target.close(1001)
          })
        )
      )
    ).pipe(Effect.catchAllCause(() => Effect.void))
    return HttpServerResponse.empty()
  })
