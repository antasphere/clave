import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  throw new Error('the Jev client imported electron')
})

import { JEV_REFUSED_PREFIX } from '../../shared/jev'
import { askJev, namesModelGone, readJevAnswers, retryAfterMs, type JevRequest } from './jev-client'

// One request to Jev (PRDCT-5179), against a stubbed `fetch`: every outcome,
// and answers read defensively. The key is invented; nothing leaves.

const KEY = 'ts-unit-test-key-0001'
const request: JevRequest = {
  state: { note: 'An invented tab.' },
  questions: { fits: { type: 'noul', instructions: 'Yes?' } }
}

function answer(status: number, body: unknown, headers: Record<string, string> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers }))
  )
}
const ask = (signal?: AbortSignal): ReturnType<typeof askJev> =>
  askJev({
    baseUrl: 'http://typesafe.test',
    key: KEY,
    model: 'jev-1.14.0',
    request,
    timeoutMs: 1000,
    signal
  })

afterEach(() => vi.unstubAllGlobals())

describe('askJev', () => {
  it('reads a documented answer, the model that answered and the tokens', async () => {
    answer(200, {
      model: 'jev-1.14.0',
      answers: {
        project: {
          type: 'choice',
          choice: 'Quill',
          confidence: 0.9,
          probabilities: { Quill: 0.9, Atlas: 0.1 }
        },
        fits: { type: 'noul', noul: 0.97 }
      },
      usage: { input_tokens: 812, output_tokens: 4 }
    })
    const outcome = await ask()
    expect(outcome).toMatchObject({
      kind: 'ok',
      model: 'jev-1.14.0',
      inputTokens: 812,
      answers: {
        project: { type: 'choice', choice: 'Quill', probabilities: { Quill: 0.9, Atlas: 0.1 } },
        fits: { type: 'noul', noul: 0.97 }
      }
    })
  })

  it('drops an answer that is not the documented shape', () => {
    expect(
      readJevAnswers({
        a: { type: 'noul', noul: 1.5 },
        b: { type: 'choice', choice: 'x', confidence: 0.5, probabilities: { x: 'high' } },
        c: { type: 'score', score: 1 },
        d: 'yes',
        e: { type: 'noul', noul: 0.2 }
      })
    ).toEqual({ e: { type: 'noul', noul: 0.2 } })
    expect(readJevAnswers(null)).toEqual({})
  })

  it('a 401 or a 403 is refused, in its own words without the key', async () => {
    answer(401, { detail: `Invalid API key ${KEY}` })
    expect(await ask()).toEqual({
      kind: 'refused',
      sentence: `${JEV_REFUSED_PREFIX}Invalid API key …`
    })
    answer(403, {})
    expect(await ask()).toEqual({ kind: 'refused', sentence: 'The key was refused by TypeSafe.' })
  })

  it('a 429 or a 529 is a limit, with the wait the service asks', async () => {
    answer(429, { detail: 'Slow down' }, { 'retry-after': '2' })
    expect(await ask()).toEqual({ kind: 'limit', retryAfterMs: 2000 })
    answer(529, { detail: 'Overloaded' })
    expect(await ask()).toEqual({ kind: 'limit', retryAfterMs: null })
  })

  it('a model the service does not know is model-gone; any other 400 is failed, cleaned', async () => {
    answer(422, { detail: [{ loc: ['body', 'model'], msg: 'Unknown model', type: 'value_error' }] })
    expect(await ask()).toEqual({ kind: 'model-gone' })
    answer(400, { detail: 'The model jev-1.14.0 does not exist.' })
    expect(await ask()).toEqual({ kind: 'model-gone' })
    answer(400, { detail: `max_tokens_exceeded: longer than the model's context length (${KEY})` })
    expect(await ask()).toEqual({
      kind: 'failed',
      status: 400,
      detail: "max_tokens_exceeded: longer than the model's context length (…)"
    })
  })

  it('no answer is unreachable: the network, the deadline, the caller abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    expect(await ask()).toEqual({ kind: 'unreachable' })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            // As the real fetch: a signal already aborted rejects at once.
            if (init.signal!.aborted) reject(new Error('aborted'))
            init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
          })
      )
    )
    const controller = new AbortController()
    const asked = ask(controller.signal)
    controller.abort()
    expect(await asked).toEqual({ kind: 'unreachable' })
    const aborted = new AbortController()
    aborted.abort()
    expect(await ask(aborted.signal)).toEqual({ kind: 'unreachable' })
  })
})

describe('the pure readers', () => {
  it('reads retry-after as seconds or a date', () => {
    expect(retryAfterMs('1.5')).toBe(1500)
    expect(retryAfterMs(null)).toBeNull()
    expect(retryAfterMs('soon')).toBeNull()
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000)
  })

  it('names a model gone only on a body that says so', () => {
    expect(namesModelGone(404, '{"detail":"model not found"}')).toBe(true)
    expect(namesModelGone(500, '{"detail":"model not found"}')).toBe(false)
    expect(
      namesModelGone(422, '{"detail":[{"loc":["body","state"],"msg":"Field required"}]}')
    ).toBe(false)
    expect(namesModelGone(400, '{"detail":"Invalid UTF-8"}')).toBe(false)
  })
})
