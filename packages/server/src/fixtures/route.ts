/**
 * The test fixture route, `POST /e2e/evaluate`: the end-to-end suite's one
 * way into the process that hosts the sessions, whichever server runs
 * (PRDCT-3293). The specs used to evaluate a function inside Electron main
 * to wrap the session host, stub a settings read or replace `fetch`; with
 * the server as its own process those objects live where no `app.evaluate`
 * reaches, so the same function source is sent here and run in THIS
 * process, with `globalThis` (and its `__claveE2E` namespace) as the
 * specs know it. The body is `{ source, arg? }`, `source` the text of a
 * function; the answer is `{ ok: true, value }` with the function's awaited
 * result, or `{ ok: false, error }` with the message it threw.
 *
 * It runs code it is sent, so it exists ONLY when the server is started in
 * test mode (`testFixtures` in the entry's options, which the app sets from
 * `--test-no-activate` and the packaged app never passes): started without
 * it, the path is not registered at all and answers 404 like any unknown
 * path. The route sits inside the token check, so a caller without the
 * server's token gets 401 before any of this runs, and the server itself
 * binds the loopback only. `route.test.ts` pins the three gates.
 */
import { Effect } from 'effect'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import { type Wrap, pathOf } from '../auth'

export const FIXTURE_PATH = '/e2e/evaluate'

interface EvaluateBody {
  readonly source: string
  readonly arg?: unknown
}

const isBody = (value: unknown): value is EvaluateBody =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { source?: unknown }).source === 'string'

const messageOf = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error)

/** Run the function the source names, in this process, with the argument. */
async function evaluate(body: EvaluateBody): Promise<{ ok: true; value: unknown }> {
  // The source is a function expression (`() => …`, `async (arg) => …`,
  // `function (arg) { … }`), the way Playwright's own evaluate takes one.
  const fn = new Function(`return (${body.source})`)() as (arg: unknown) => unknown
  if (typeof fn !== 'function') throw new Error('the fixture source is not a function')
  const value = await fn(body.arg)
  return { ok: true, value: value === undefined ? null : value }
}

/** The route when fixtures are on; the app untouched when they are off. */
export const fixtureRoute =
  (enabled: boolean): Wrap =>
  (app) =>
    enabled
      ? Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (pathOf(request.url) !== FIXTURE_PATH) return yield* app
          if (request.method !== 'POST')
            return HttpServerResponse.text('The fixture route takes a POST.', { status: 405 })
          const parsed = yield* Effect.either(request.json)
          const body = parsed._tag === 'Right' && isBody(parsed.right) ? parsed.right : null
          if (!body)
            return HttpServerResponse.unsafeJson(
              { ok: false, error: 'a JSON body { source, arg? } is expected' },
              { status: 400 }
            )
          const answer = yield* Effect.promise(() =>
            evaluate(body).catch((error) => ({ ok: false as const, error: messageOf(error) }))
          )
          return HttpServerResponse.unsafeJson(answer)
        })
      : app
