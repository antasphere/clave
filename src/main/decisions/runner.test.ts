import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  throw new Error('the decisions runner imported electron')
})

import { DECISIONS_NEED_KEY } from '../../shared/decision-preferences'
import type { AskJevOptions, JevOutcome } from './jev-client'
import {
  defineDecision,
  resetDecisionsForTests,
  setDecisionConfigSource,
  type DecisionDefinition
} from './registry'
import {
  cancelAll,
  MAX_RUNNING_DECISIONS,
  MODEL_RETRY_MS,
  queuedDecisions,
  resetShutdownForTests,
  runDecision,
  runningDecisions,
  shutdown,
  type RunDecisionOptions
} from './runner'

// The decisions' runner (PRDCT-5179): every outcome, the fallback model, the
// one retry after a limit, the cap of four and the quit. The request is a
// stub (`ask`); one case goes through `fetch`, stubbed too. No real network.

const KEY = 'ts-unit-test-key-0001'

const ok = (p = 0.97, model = 'jev-1.14.0'): JevOutcome => ({
  kind: 'ok',
  answers: { fits: { type: 'noul', noul: p } },
  model,
  inputTokens: 42,
  ms: 210
})

let asked: AskJevOptions[]
let replies: Array<JevOutcome | Promise<JevOutcome>>
const replying = async (options: AskJevOptions): Promise<JevOutcome> => {
  asked.push(options)
  return replies.length > 1 ? replies.shift()! : replies[0]
}
const ask = vi.fn(replying)
const options: RunDecisionOptions = {
  openKey: async () => KEY,
  baseUrl: () => 'http://typesafe.test',
  ask
}

let quill: DecisionDefinition<string, number>
beforeEach(() => {
  asked = []
  replies = [ok()]
  ask.mockReset()
  ask.mockImplementation(replying)
  quill = defineDecision<string, number>({
    id: 'quill-fits',
    label: 'Quill fits',
    description: 'An invented decision.',
    model: 'jev-1.14.0',
    fallbackModel: 'jev-latest',
    timeoutMs: 1000,
    build: (input) =>
      input === ''
        ? null
        : { state: input, questions: { fits: { type: 'noul', instructions: 'Yes?' } } },
    read: (answers) => (answers.fits?.type === 'noul' ? answers.fits.noul : null)
  })
})
afterEach(() => {
  cancelAll()
  resetShutdownForTests()
  resetDecisionsForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('runDecision', () => {
  it('answers the value read, the model that answered, the time and the tokens', async () => {
    replies = [ok(0.97, 'jev-1.14.0')]
    expect(await runDecision(quill, 'a tab', options)).toEqual({
      ok: true,
      value: 0.97,
      model: 'jev-1.14.0',
      ms: 210,
      inputTokens: 42
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      baseUrl: 'http://typesafe.test',
      key: KEY,
      model: 'jev-1.14.0',
      timeoutMs: 1000,
      request: { state: 'a tab' }
    })
  })

  it('switched off: disabled, nothing asked, the key not even read', async () => {
    const openKey = vi.fn(async () => KEY)
    setDecisionConfigSource(() => ({ enabled: false }))
    expect(await runDecision(quill, 'a tab', { ...options, openKey })).toEqual({
      ok: false,
      reason: 'disabled',
      detail: 'Switched off in Settings › Helpers (Quill fits).'
    })
    expect(openKey).not.toHaveBeenCalled()
    expect(asked).toHaveLength(0)
  })

  it('refused in this process: disabled, with the sentence as the detail', async () => {
    setDecisionConfigSource(() => ({ refused: "Decisions run on Clave's server." }))
    expect(await runDecision(quill, 'a tab', options)).toEqual({
      ok: false,
      reason: 'disabled',
      detail: "Decisions run on Clave's server."
    })
    expect(asked).toHaveLength(0)
  })

  it('no key: no-key, nothing asked', async () => {
    expect(await runDecision(quill, 'a tab', { ...options, openKey: async () => null })).toEqual({
      ok: false,
      reason: 'no-key',
      detail: DECISIONS_NEED_KEY
    })
    expect(asked).toHaveLength(0)
  })

  it('nothing to ask: nothing, no request', async () => {
    expect((await runDecision(quill, '', options)) as { reason: string }).toMatchObject({
      ok: false,
      reason: 'nothing'
    })
    expect(asked).toHaveLength(0)
  })

  it('maps every failure of the request', async () => {
    const cases: Array<[JevOutcome, string]> = [
      [{ kind: 'refused', sentence: 'The key was refused by TypeSafe.' }, 'refused'],
      [{ kind: 'unreachable' }, 'unreachable'],
      [{ kind: 'failed', status: 400, detail: 'max_tokens_exceeded' }, 'failed'],
      [{ kind: 'ok', answers: {}, model: 'jev-1.14.0', inputTokens: 1, ms: 1 }, 'unreadable']
    ]
    for (const [reply, reason] of cases) {
      replies = [reply]
      expect(await runDecision(quill, 'a tab', options)).toMatchObject({ ok: false, reason })
    }
    replies = [{ kind: 'refused', sentence: 'TypeSafe refused the key: Revoked.' }]
    expect(await runDecision(quill, 'a tab', options)).toEqual({
      ok: false,
      reason: 'refused',
      detail: 'TypeSafe refused the key: Revoked.'
    })
  })

  it('a model gone: one more request on the fallback', async () => {
    replies = [{ kind: 'model-gone' }, ok(0.9, 'jev-1.15.0')]
    expect(await runDecision(quill, 'a tab', options)).toMatchObject({
      ok: true,
      model: 'jev-1.15.0'
    })
    expect(asked.map((a) => a.model)).toEqual(['jev-1.14.0', 'jev-latest'])
  })

  it('the fallback refused too: the declared model once more, three requests at most', async () => {
    // Measured on 26 November 2026: TypeSafe refuses a model it serves, now
    // and then, and answers the same request a moment later.
    replies = [{ kind: 'model-gone' }, { kind: 'model-gone' }, ok(0.9, 'jev-1.14.0')]
    expect(await runDecision(quill, 'a tab', options)).toMatchObject({
      ok: true,
      model: 'jev-1.14.0'
    })
    expect(asked.map((a) => a.model)).toEqual(['jev-1.14.0', 'jev-latest', 'jev-1.14.0'])
    replies = [{ kind: 'model-gone' }]
    asked = []
    expect(await runDecision(quill, 'a tab', options)).toMatchObject({
      ok: false,
      reason: 'failed'
    })
    expect(asked.map((a) => a.model)).toEqual(['jev-1.14.0', 'jev-latest', 'jev-1.14.0'])
  })

  it('a model gone with no fallback: the same model once more, then failed', async () => {
    const atlas = defineDecision<string, number>({
      ...quill,
      id: 'atlas-fits',
      fallbackModel: undefined
    })
    replies = [{ kind: 'model-gone' }, ok(0.9)]
    expect(await runDecision(atlas, 'a tab', options)).toMatchObject({ ok: true })
    expect(asked.map((a) => a.model)).toEqual(['jev-1.14.0', 'jev-1.14.0'])
    replies = [{ kind: 'model-gone' }]
    asked = []
    expect(await runDecision(atlas, 'a tab', options)).toMatchObject({
      ok: false,
      reason: 'failed'
    })
    expect(asked).toHaveLength(2)
  })

  it('a cancel during the pause before the model is asked again sends nothing more', async () => {
    replies = [{ kind: 'model-gone' }, { kind: 'model-gone' }, ok()]
    const running = runDecision(quill, 'a tab', options)
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    cancelAll()
    expect(await running).toMatchObject({ ok: false, reason: 'cancelled' })
    await new Promise((resolve) => setTimeout(resolve, MODEL_RETRY_MS + 50))
    expect(asked).toHaveLength(2)
  })

  it('a limit: ONE retry after the wait the service asks, capped, then limit', async () => {
    vi.useFakeTimers()
    replies = [{ kind: 'limit', retryAfterMs: 60_000 }, ok()]
    const running = runDecision(quill, 'a tab', options)
    await vi.advanceTimersByTimeAsync(1499)
    expect(asked).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await running).toMatchObject({ ok: true })
    expect(asked).toHaveLength(2)

    asked = []
    replies = [{ kind: 'limit', retryAfterMs: null }]
    const limited = runDecision(quill, 'a tab', options)
    await vi.advanceTimersByTimeAsync(499)
    expect(asked).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await limited).toMatchObject({ ok: false, reason: 'limit' })
    expect(asked).toHaveLength(2)
  })

  it('holds at most four requests in flight, the rest in turn', async () => {
    const releases: Array<() => void> = []
    ask.mockImplementation(async (o: AskJevOptions) => {
      asked.push(o)
      await new Promise<void>((resolve) => releases.push(resolve))
      return ok()
    })
    const all = Array.from({ length: 6 }, (_, i) => runDecision(quill, `tab ${i}`, options))
    await vi.waitFor(() => expect(runningDecisions()).toBe(MAX_RUNNING_DECISIONS))
    expect(queuedDecisions()).toEqual(['quill-fits', 'quill-fits'])
    releases.shift()!()
    await vi.waitFor(() => expect(asked).toHaveLength(5))
    expect(runningDecisions()).toBe(4)
    while (releases.length) releases.shift()!()
    await vi.waitFor(() => expect(asked).toHaveLength(6))
    while (releases.length) releases.shift()!()
    for (const outcome of await Promise.all(all)) expect(outcome.ok).toBe(true)
    expect(asked.map((a) => a.request.state)).toEqual([0, 1, 2, 3, 4, 5].map((i) => `tab ${i}`))
  })

  it('cancelAll aborts the running requests and answers the waiting ones cancelled; the door stays open', async () => {
    const signals: AbortSignal[] = []
    ask.mockImplementation(
      (o: AskJevOptions) =>
        new Promise<JevOutcome>((resolve) => {
          signals.push(o.signal!)
          o.signal!.addEventListener('abort', () => resolve({ kind: 'unreachable' }))
        })
    )
    const all = Array.from({ length: 5 }, (_, i) => runDecision(quill, `tab ${i}`, options))
    await vi.waitFor(() => expect(signals).toHaveLength(4))
    cancelAll()
    for (const outcome of await Promise.all(all))
      expect(outcome).toEqual({ ok: false, reason: 'cancelled', detail: 'Cancelled' })
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    ask.mockImplementation(async () => ok())
    expect(await runDecision(quill, 'again', options)).toMatchObject({ ok: true })
  })

  it('a cancel during the wait before a retry sends no second request', async () => {
    replies = [{ kind: 'limit', retryAfterMs: 1000 }, ok()]
    const running = runDecision(quill, 'a tab', options)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    cancelAll()
    expect(await running).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(asked).toHaveLength(1)
  })

  it('shutdown ends everything and shuts the door', async () => {
    ask.mockImplementation(
      (o: AskJevOptions) =>
        new Promise<JevOutcome>((resolve) =>
          o.signal!.addEventListener('abort', () => resolve({ kind: 'unreachable' }))
        )
    )
    const running = runDecision(quill, 'a tab', options)
    await vi.waitFor(() => expect(runningDecisions()).toBe(1))
    shutdown()
    expect(await running).toMatchObject({ ok: false, reason: 'cancelled' })
    ask.mockImplementation(async () => ok())
    expect(await runDecision(quill, 'after', options)).toMatchObject({
      ok: false,
      reason: 'cancelled'
    })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('goes through fetch by default: the endpoint, the bearer key, the body', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(
          JSON.stringify({
            model: 'jev-1.14.0',
            answers: { fits: { type: 'noul', noul: 0.8 } },
            usage: { input_tokens: 99, output_tokens: 1 }
          }),
          { status: 200 }
        )
      })
    )
    const outcome = await runDecision(quill, 'a tab', {
      openKey: async () => KEY,
      baseUrl: () => 'http://typesafe.test/'
    })
    expect(outcome).toMatchObject({ ok: true, value: 0.8, inputTokens: 99 })
    expect(calls[0].url).toBe('http://typesafe.test/v1/systemone')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: 'jev-1.14.0',
      state: 'a tab',
      questions: { fits: { type: 'noul', instructions: 'Yes?' } }
    })
  })
})
