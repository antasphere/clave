/**
 * The token check: the server listens on loopback and answers only a caller
 * presenting the token it was started with, the MCP server's shape. The
 * health probes stay open, they say nothing a stranger could use.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { Effect, Option } from 'effect'
import type * as HttpApp from '@effect/platform/HttpApp'
import * as HttpIncomingMessage from '@effect/platform/HttpIncomingMessage'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import { ForbiddenProblem, UnauthorizedProblem, problemResponse } from '@structure-ai/http'
import { Correlation } from '@structure-ai/observability'
import { DEVICE_PAIR_PATH } from '@clave/contract/devices'
// ── Mobile wave, lane A: a phone's own credential beside the server's token ──
import { OWNER_ACTOR, deviceActor } from './devices/actor'
import { DEVICE_FORBIDDEN_MESSAGE, deviceMayCall } from './devices/scope'

/** Equal in constant time, whatever the lengths: both sides are hashed first. */
export const safeEqual = (presented: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(expected).digest()
  )

export const tokenMatches = (header: string | undefined, token: string): boolean =>
  header !== undefined && header.startsWith('Bearer ') && safeEqual(header.slice(7), token)

export const pathOf = (url: string): string => {
  const end = url.indexOf('?')
  return end === -1 ? url : url.slice(0, end)
}

/** The paths that take no bearer: the health probes, and the pairing route a
 *  phone asks on before it has any credential (the proof is in its body). */
export const isOpenPath = (path: string): boolean =>
  path.startsWith('/health/') || path === DEVICE_PAIR_PATH

/** A pairing request body is a token and a name: this much and no more. */
export const PAIR_BODY_MAX_BYTES = 16 * 1024

/** The bearer presented, when the header has the shape. */
export const bearerOf = (header: string | undefined): string | undefined =>
  header !== undefined && header.startsWith('Bearer ') ? header.slice(7) : undefined

/** What the token check asks of the devices domain: whether a presented
 *  credential is a phone's session, and to record the phone was seen. */
export interface DeviceAuth {
  readonly authenticate: (presented: string) => { readonly deviceId: string } | null
  readonly touch: (deviceId: string) => void
}

/** A middleware that keeps the app's own error and requirement types. */
export type Wrap = <E, R>(
  app: HttpApp.Default<E, R>
) => HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest>

/**
 * The token check, with the actor it establishes carried on the correlation
 * context for the rest of the request (the bus copies it into every
 * dispatch, so a handler knows who asked): `owner` for the server's token,
 * `device:<id>` for a phone's session. A phone is kept to what a phone does
 * (`devices/scope.ts`): any other route answers 403 with one sentence, and
 * every call it does make is recorded as its last-seen time.
 */
export const bearerAuth =
  (token: string, devices?: DeviceAuth): Wrap =>
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = pathOf(request.url)
      if (path === DEVICE_PAIR_PATH) return yield* boundedPairBody(app)
      if (isOpenPath(path)) return yield* app
      const header = request.headers['authorization']
      if (tokenMatches(header, token)) return yield* Correlation.within({ actor: OWNER_ACTOR })(app)
      const presented = bearerOf(header)
      const device = presented === undefined ? null : (devices?.authenticate(presented) ?? null)
      if (device) {
        if (!deviceMayCall(request.method, path))
          return problemResponse(
            new ForbiddenProblem({ error: 'Forbidden', message: DEVICE_FORBIDDEN_MESSAGE })
          )
        devices!.touch(device.deviceId)
        return yield* Correlation.within({ actor: deviceActor(device.deviceId) })(app)
      }
      return problemResponse(
        new UnauthorizedProblem({
          error: 'Unauthenticated',
          message: 'This server answers only a caller presenting its token.'
        })
      )
    })

/** The pairing route is open, so its body is bounded before it is read. */
const boundedPairBody = <E, R>(
  app: HttpApp.Default<E, R>
): HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const length = Number(request.headers['content-length'])
    if (Number.isFinite(length) && length > PAIR_BODY_MAX_BYTES)
      return Effect.succeed(HttpServerResponse.empty({ status: 413 }))
    return HttpIncomingMessage.withMaxBodySize(app, Option.some(PAIR_BODY_MAX_BYTES))
  })
