/**
 * The phone's road to this server without a relay (PRDCT-4448). The native
 * phone apps reach a machine through a relay: `GET <relay>/machines`, with
 * the hub's access token as the bearer, lists the person's machines, and
 * `<relay>/m/<machine>/<path>` is the road to one of them, the device
 * session's bearer travelling through, the push socket at `/m/<machine>/push`.
 * A server reached directly at an HTTPS address of its own (Tailscale Serve
 * on a private network) answers those two shapes itself, so the unchanged
 * app pairs and works with that address typed as its relay:
 *
 * - `GET /machines` lists this server, and only to the hub account signed in
 *   on it. The bearer is asked of the hub's userinfo endpoint (the relay's
 *   own check, `hub-bearer.ts`) on the issuer the devices domain trusts, and
 *   the subject must be this server's owner, read before the hub is asked
 *   and again after it answered. A server with no owner, or with an issuer it
 *   refuses, answers 401 and asks the hub nothing. What is asked of the hub
 *   is bounded: a deadline, a few requests at a time, a budget per minute,
 *   and a bounded cache keyed by the token's hash; no token and no hash is
 *   ever logged.
 * - `/m/<id>/<path>` is `/<path>`, rewritten BEFORE the push upgrade, the
 *   token check and the device scope see the request, so the alias reaches
 *   exactly what the same request without it reaches. `<id>` is this
 *   server's own machine id, compared byte for byte; another id, an encoded
 *   one, an empty or dotted segment, a percent sign or a backslash in the
 *   path answers 404 and reaches nothing.
 *
 * The machine id is the entry's (`DevicesPortService.road`): minted once and
 * kept with the server's data, so a phone paired with this server finds it
 * under the same id after every restart. Without `road`, nothing here exists.
 */
import { Context, Effect, Layer } from 'effect'
import type * as HttpApp from '@effect/platform/HttpApp'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import { HubBearerCheck } from './hub-bearer'
import { resolveAntasphereIssuer } from './identity-token'
import { DevicesPort, type DevicesPortService } from './port'

/** Where a phone lists the machines of the person signed in. */
export const MACHINES_PATH = '/machines'
/** A machine id this server mints for its road: `m_` and 32 hex digits. */
export const ROAD_MACHINE_ID = /^m_[0-9a-f]{32}$/
/** One segment of a path behind the road: the characters every route of the API is spelled with. */
const SEGMENT = /^[A-Za-z0-9_-]+$/

/** The bounds of what the road asks the hub. */
export const ROAD_HUB_TIMEOUT_MS = 5_000
export const ROAD_HUB_CONCURRENCY = 4
export const ROAD_HUB_PER_MINUTE = 30
export const ROAD_HUB_CACHE_ENTRIES = 256

/** What a request is to the road. */
export type RoadRoute =
  | { readonly kind: 'pass' }
  | { readonly kind: 'machines' }
  | { readonly kind: 'alias'; readonly url: string }
  | { readonly kind: 'refused' }

/**
 * What the road makes of a request URL (path and query, as the listener
 * hands it over). `machineId` answers this server's machine id, or null when
 * it has none it can trust; it is asked only for a request on the road
 * (`/m/...`), so no other request reads or mints it. The one place the alias
 * is decided.
 */
export function roadRoute(url: string, machineId: () => string | null): RoadRoute {
  const cut = url.indexOf('?')
  const path = cut === -1 ? url : url.slice(0, cut)
  const query = cut === -1 ? '' : url.slice(cut)
  if (path === MACHINES_PATH) return { kind: 'machines' }
  if (path !== '/m' && !path.startsWith('/m/')) return { kind: 'pass' }
  const id = machineId()
  if (id === null) return { kind: 'refused' }
  const rest = path.slice('/m/'.length)
  const slash = rest.indexOf('/')
  if (slash === -1 || rest.slice(0, slash) !== id) return { kind: 'refused' }
  const inner = rest.slice(slash)
  if (
    !inner
      .slice(1)
      .split('/')
      .every((segment) => SEGMENT.test(segment))
  )
    return { kind: 'refused' }
  return { kind: 'alias', url: `${inner}${query}` }
}

/** The most a hub answer may weigh: its discovery document and its userinfo are a few
 *  hundred bytes; the reviewed check itself refuses a discovery document over 256 KiB. */
export const ROAD_HUB_MAX_BYTES = 256 * 1024

/** A promise that rejects when the signal aborts, for a call that may not heed it. */
const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('the hub did not answer in time'))
    else
      signal.addEventListener('abort', () => reject(new Error('the hub did not answer in time')), {
        once: true
      })
  })

/** The whole body, at most `max` bytes, read before `signal` aborts; the stream is let go either way. */
async function readBounded(
  response: Response,
  max: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const release = (): void => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', release, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), untilAborted(signal)])
      if (done) break
      size += value.byteLength
      if (size > max) throw new Error('the hub answered more than this server reads')
      chunks.push(value)
    }
  } catch (error) {
    release()
    throw error
  } finally {
    signal.removeEventListener('abort', release)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}

/**
 * A `fetch` that keeps to the road's budget for the WHOLE exchange: a few requests at a time
 * and so many a minute, one deadline over the headers and the body together, and a bound on
 * the body's size. The body is read here, and the caller is handed an answer already read, so
 * a hub that sends its headers and then holds its body can neither keep a caller waiting past
 * the deadline nor hold more than the budget open. Over the budget, or past the deadline, it
 * throws, which the bearer check reads as a hub that did not answer (503).
 */
export function budgetedFetch(
  base: typeof globalThis.fetch,
  now: () => number,
  limits: {
    readonly concurrency: number
    readonly perMinute: number
    readonly timeoutMs?: number
    readonly maxBytes?: number
  } = { concurrency: ROAD_HUB_CONCURRENCY, perMinute: ROAD_HUB_PER_MINUTE }
): typeof globalThis.fetch {
  let inFlight = 0
  const started: number[] = []
  const timeoutMs = limits.timeoutMs ?? ROAD_HUB_TIMEOUT_MS
  const maxBytes = limits.maxBytes ?? ROAD_HUB_MAX_BYTES
  const limited = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    const at = now()
    while (started.length > 0 && started[0]! <= at - 60_000) started.shift()
    if (inFlight >= limits.concurrency || started.length >= limits.perMinute)
      throw new Error('the hub budget of this server is spent')
    inFlight += 1
    started.push(at)
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    const outer = init?.signal
    const follow = (): void => deadline.abort()
    if (outer?.aborted) deadline.abort()
    outer?.addEventListener('abort', follow, { once: true })
    try {
      const response = await Promise.race([
        base(input, { ...init, signal: deadline.signal }),
        untilAborted(deadline.signal)
      ])
      const body = await readBounded(response, maxBytes, deadline.signal)
      return new Response(
        body.byteLength === 0 && [204, 304].includes(response.status)
          ? null
          : (body.buffer as ArrayBuffer),
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        }
      )
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', follow)
      inFlight -= 1
    }
  }
  return limited as typeof globalThis.fetch
}

export interface PhoneRoadService {
  /** The road around the rest of the server's middleware, outermost. */
  readonly wrap: <E, R>(
    app: HttpApp.Default<E, R>
  ) => HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest>
}

const json = (status: number, body: unknown): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.unsafeJson(body, { status })
const unauthenticated = (): HttpServerResponse.HttpServerResponse =>
  json(401, {
    error: 'Unauthenticated',
    message: 'This server lists itself only to its owner, signed in at the hub.'
  })
const notFound = (): HttpServerResponse.HttpServerResponse =>
  json(404, { error: 'NotFound', message: 'No such machine on this server.' })

/** The owner's subject, or null when nobody is signed in or the read fails. */
const ownerOf = async (port: DevicesPortService): Promise<string | null> => {
  try {
    const owner = await port.owner()
    return typeof owner === 'string' && owner !== '' ? owner : null
  } catch {
    return null
  }
}

/** The road over one devices port; its hub check and budget live as long as the server. */
export function phoneRoad(port: DevicesPortService): PhoneRoadService {
  const road = port.road
  if (!road) return { wrap: (app) => app }
  const now = port.now ?? (() => Date.now())
  const issuer = resolveAntasphereIssuer(port.issuer)
  const check = issuer.ok
    ? new HubBearerCheck({
        issuer: issuer.config.issuer.origin,
        fetch: budgetedFetch(port.fetch ?? ((input, init) => globalThis.fetch(input, init)), now),
        now,
        maxCached: ROAD_HUB_CACHE_ENTRIES,
        requestTimeoutMs: ROAD_HUB_TIMEOUT_MS
      })
    : null
  const machineId = (): string | null => {
    try {
      const id = road.machineId()
      return ROAD_MACHINE_ID.test(id) ? id : null
    } catch {
      return null
    }
  }
  const machines = async (
    authorization: string | undefined
  ): Promise<HttpServerResponse.HttpServerResponse> => {
    const owner = await ownerOf(port)
    if (owner === null || check === null) return unauthenticated()
    const id = machineId()
    if (id === null)
      return json(503, {
        error: 'Unavailable',
        message: 'This server has no machine id it can read.'
      })
    const outcome = await check.check(authorization)
    if (!outcome.ok)
      return outcome.status === 401
        ? unauthenticated()
        : json(503, { error: 'Unavailable', message: 'The hub could not be asked.' })
    // The owner is read again: a sign-out or another account while the hub
    // answered lists nothing.
    const still = await ownerOf(port)
    if (still !== owner || outcome.sub !== owner) return json(200, { machines: [] })
    return json(200, {
      machines: [
        {
          id,
          name: port.serverName(),
          platform: road.platform,
          version: road.version,
          online: true,
          lastSeen: now(),
          direct: []
        }
      ]
    })
  }
  return {
    wrap: (app) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
        const route = roadRoute(request.url, machineId)
        switch (route.kind) {
          case 'pass':
            return app
          case 'machines':
            if (request.method !== 'GET') return app
            return Effect.promise(() => machines(request.headers['authorization']))
          case 'refused':
            return Effect.succeed(notFound())
          case 'alias':
            return Effect.provideService(
              app,
              HttpServerRequest.HttpServerRequest,
              request.modify({ url: route.url })
            )
        }
      })
  }
}

/** The road as a service of the server, built once over the devices port. */
export class PhoneRoad extends Context.Tag('@clave/server/PhoneRoad')<
  PhoneRoad,
  PhoneRoadService
>() {
  static readonly layer: Layer.Layer<PhoneRoad, never, DevicesPort> = Layer.effect(
    PhoneRoad,
    Effect.map(DevicesPort, phoneRoad)
  )
}
