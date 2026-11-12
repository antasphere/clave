import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOLD_RETRY_MS, startHoldLoop, type HoldLoopDeps } from './artefact-hold'

/**
 * The hold loop of an artefact's frame (PRDCT-4474), over fake timers and a
 * fake `hold` whose answers the test gives by hand: one call at a time, a
 * wake-up during a call in flight run once after it, and every hold the loop
 * was given released once it stops.
 */

interface Call {
  readonly holdId: string | undefined
  answer(value: { url: string; holdId: string; ttlMs: number }): Promise<void>
  fail(error: Error): Promise<void>
}

function fake(): {
  deps: HoldLoopDeps
  calls: Call[]
  inFlight: () => number
  maxInFlight: () => number
  released: string[]
  urls: string[]
  refused: string[]
} {
  const calls: Call[] = []
  const released: string[] = []
  const urls: string[] = []
  const refused: string[] = []
  let open = 0
  let most = 0
  const deps: HoldLoopDeps = {
    hold: (holdId) =>
      new Promise((resolve, reject) => {
        open += 1
        most = Math.max(most, open)
        const settle = async (run: () => void): Promise<void> => {
          open -= 1
          run()
          // Let the loop's own handlers run.
          await Promise.resolve()
          await Promise.resolve()
        }
        calls.push({
          holdId,
          answer: (value) => settle(() => resolve(value)),
          fail: (error) => settle(() => reject(error))
        })
      }),
    release: async (holdId) => {
      released.push(holdId)
    },
    onUrl: (url) => urls.push(url),
    onRefused: (message) => refused.push(message)
  }
  return {
    deps,
    calls,
    inFlight: () => open,
    maxInFlight: () => most,
    released,
    urls,
    refused
  }
}

const TTL = 90_000
const answer = (
  holdId: string,
  url = 'http://127.0.0.1:4000/'
): {
  url: string
  holdId: string
  ttlMs: number
} => ({ url, holdId, ttlMs: TTL })

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the hold loop of an artefact frame', () => {
  it('runs exactly one more call for two wake-ups during a call in flight, never two at once', async () => {
    const f = fake()
    const loop = startHoldLoop(f.deps)
    expect(f.calls).toHaveLength(1)
    loop.wake()
    loop.wake()
    expect(f.calls).toHaveLength(1)
    await f.calls[0]!.answer(answer('h1'))
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]!.holdId).toBe('h1')
    await f.calls[1]!.answer(answer('h1'))
    // Nothing more until the renewal's time.
    expect(f.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(TTL / 3)
    expect(f.calls).toHaveLength(3)
    expect(f.maxInFlight()).toBe(1)
    loop.stop()
  })

  it('a wake-up with no call in flight renews at once, and the timer does not add another', async () => {
    const f = fake()
    const loop = startHoldLoop(f.deps)
    await f.calls[0]!.answer(answer('h1'))
    loop.wake()
    expect(f.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(TTL)
    expect(f.calls).toHaveLength(2)
    expect(f.maxInFlight()).toBe(1)
    loop.stop()
  })

  it('releases the held id when it stops, and calls no more', async () => {
    const f = fake()
    const loop = startHoldLoop(f.deps)
    await f.calls[0]!.answer(answer('h1'))
    loop.stop()
    expect(f.released).toEqual(['h1'])
    await vi.advanceTimersByTimeAsync(TTL)
    loop.wake()
    expect(f.calls).toHaveLength(1)
  })

  it('releases the hold of an answer that arrives after it stopped', async () => {
    const f = fake()
    const loop = startHoldLoop(f.deps)
    loop.stop()
    expect(f.released).toEqual([])
    await f.calls[0]!.answer(answer('late'))
    expect(f.released).toEqual(['late'])
    expect(f.urls).toEqual([])
  })

  it('says a refused first hold, says nothing of a failed renewal, and tries again ten seconds later', async () => {
    const f = fake()
    const loop = startHoldLoop(f.deps)
    await f.calls[0]!.fail(
      new Error("Error invoking remote method 'artefacts:hold': Error: Slideless is not installed.")
    )
    expect(f.refused).toEqual(['Slideless is not installed.'])
    await vi.advanceTimersByTimeAsync(HOLD_RETRY_MS - 1)
    expect(f.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.calls).toHaveLength(2)
    await f.calls[1]!.answer(answer('h1'))
    await vi.advanceTimersByTimeAsync(TTL / 3)
    await f.calls[2]!.fail(new Error('the server is away'))
    expect(f.refused).toEqual(['Slideless is not installed.'])
    await vi.advanceTimersByTimeAsync(HOLD_RETRY_MS)
    expect(f.calls).toHaveLength(4)
    expect(f.calls[3]!.holdId).toBe('h1')
    loop.stop()
  })

  it('gives the first url, and a new url a renewal answers, not the same one twice', async () => {
    const f = fake()
    const loop = startHoldLoop(f.deps)
    await f.calls[0]!.answer(answer('h1', 'http://127.0.0.1:4000/'))
    await vi.advanceTimersByTimeAsync(TTL / 3)
    await f.calls[1]!.answer(answer('h1', 'http://127.0.0.1:4000/'))
    expect(f.urls).toEqual(['http://127.0.0.1:4000/'])
    await vi.advanceTimersByTimeAsync(TTL / 3)
    await f.calls[2]!.answer(answer('h2', 'http://127.0.0.1:4001/'))
    expect(f.urls).toEqual(['http://127.0.0.1:4000/', 'http://127.0.0.1:4001/'])
    loop.stop()
    expect(f.released).toEqual(['h2'])
  })
})
