/**
 * The token check: the server listens on loopback and answers only a caller
 * presenting the token it was started with, the MCP server's shape. The
 * health probes stay open, they say nothing a stranger could use.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { Effect } from 'effect'
import type * as HttpApp from '@effect/platform/HttpApp'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import { UnauthorizedProblem, problemResponse } from '@structure-ai/http'

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

export const isOpenPath = (path: string): boolean => path.startsWith('/health/')

/** A middleware that keeps the app's own error and requirement types. */
export type Wrap = <E, R>(
  app: HttpApp.Default<E, R>
) => HttpApp.Default<E, R | HttpServerRequest.HttpServerRequest>

export const bearerAuth =
  (token: string): Wrap =>
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (isOpenPath(pathOf(request.url))) return yield* app
      if (tokenMatches(request.headers['authorization'], token)) return yield* app
      return problemResponse(
        new UnauthorizedProblem({
          error: 'Unauthenticated',
          message: 'This server answers only a caller presenting its token.'
        })
      )
    })
