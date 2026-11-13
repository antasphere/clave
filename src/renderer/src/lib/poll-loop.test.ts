import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startPollLoop } from './poll-loop'

/**
 * The poll that never overlaps itself (PRDCT-3775): the next round is timed
 * from the end of the last, a slow round pushes the next one out, and a
 * trigger during a round asks for exactly one more after it.
 */

const tick = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('startPollLoop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('never runs two rounds at once, however long one takes', async () => {
    let running = 0
    let peak = 0
    let rounds = 0
    const loop = startPollLoop({
      run: async () => {
        running++
        rounds++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 12_000))
        running--
      },
      intervalMs: () => 5_000,
      maxIntervalMs: 60_000,
      immediate: true
    })
    await tick(120_000)
    loop.stop()
    expect(peak).toBe(1)
    // A 12 s round waits 24 s after it: about one round every 36 s, where a
    // five-second timer would have started twenty-four.
    expect(rounds).toBeLessThanOrEqual(4)
  })

  it('waits its interval after a quick round', async () => {
    let rounds = 0
    const loop = startPollLoop({
      run: async () => {
        rounds++
      },
      intervalMs: () => 5_000,
      maxIntervalMs: 60_000
    })
    await tick(4_999)
    expect(rounds).toBe(0)
    await tick(1)
    expect(rounds).toBe(1)
    await tick(5_000)
    expect(rounds).toBe(2)
    loop.stop()
  })

  it('folds triggers during a round into one round after it', async () => {
    let rounds = 0
    let release!: () => void
    const loop = startPollLoop({
      run: () => {
        rounds++
        return new Promise<void>((r) => (release = r))
      },
      intervalMs: () => 60_000,
      maxIntervalMs: 60_000,
      immediate: true
    })
    expect(rounds).toBe(1)
    loop.trigger()
    loop.trigger()
    loop.trigger()
    release()
    await tick(0)
    expect(rounds).toBe(2)
    release()
    await tick(0)
    expect(rounds).toBe(2)
    loop.stop()
  })

  it('runs at once on a trigger between rounds', async () => {
    let rounds = 0
    const loop = startPollLoop({
      run: async () => {
        rounds++
      },
      intervalMs: () => 30_000,
      maxIntervalMs: 60_000
    })
    loop.trigger()
    await tick(0)
    expect(rounds).toBe(1)
    loop.stop()
  })

  it('skips its rounds while hidden', async () => {
    let rounds = 0
    let hidden = true
    const loop = startPollLoop({
      run: async () => {
        rounds++
      },
      intervalMs: () => 5_000,
      maxIntervalMs: 60_000,
      isHidden: () => hidden
    })
    await tick(30_000)
    expect(rounds).toBe(0)
    hidden = false
    await tick(5_000)
    expect(rounds).toBe(1)
    loop.stop()
  })

  it('reads its interval at each round', async () => {
    let rounds = 0
    let interval = 5_000
    const loop = startPollLoop({
      run: async () => {
        rounds++
      },
      intervalMs: () => interval,
      maxIntervalMs: 60_000,
      immediate: true
    })
    interval = 30_000
    await tick(29_999)
    expect(rounds).toBe(1)
    await tick(1)
    expect(rounds).toBe(2)
    loop.stop()
  })

  it('does nothing once stopped', async () => {
    let rounds = 0
    const loop = startPollLoop({
      run: async () => {
        rounds++
      },
      intervalMs: () => 1_000,
      maxIntervalMs: 60_000
    })
    loop.stop()
    loop.trigger()
    await tick(10_000)
    expect(rounds).toBe(0)
  })
})

describe('startPollLoop while hidden', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ignores a trigger, which the shown window asks again', async () => {
    let rounds = 0
    let hidden = true
    const loop = startPollLoop({
      run: async () => {
        rounds++
      },
      intervalMs: () => 30_000,
      maxIntervalMs: 60_000,
      isHidden: () => hidden
    })
    loop.trigger()
    await vi.advanceTimersByTimeAsync(0)
    expect(rounds).toBe(0)
    hidden = false
    loop.trigger()
    await vi.advanceTimersByTimeAsync(0)
    expect(rounds).toBe(1)
    loop.stop()
  })
})
