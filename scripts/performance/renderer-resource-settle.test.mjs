/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript verification tooling */
import { describe, it, expect } from 'vitest'
import { waitForMinimum } from './renderer-resource.mjs'

function scriptedClock(wakes, start = 32768) {
  let elapsed = 0
  const waits = []
  return {
    now: () => start + elapsed,
    wait: async (ms) => {
      expect(ms).toBeGreaterThan(0)
      waits.push(ms)
      expect(wakes.length, 'unexpected extra wait').toBeGreaterThan(0)
      elapsed = wakes.shift()
    },
    elapsed: () => elapsed,
    waits
  }
}

describe('the resource settle monotonic minimum', () => {
  it('waits the remaining fraction after an early timer wake', async () => {
    const clock = scriptedClock([999.5, 1000])
    await waitForMinimum(1000, clock)
    expect(clock.elapsed()).toBeGreaterThanOrEqual(1000)
    expect(clock.waits).toEqual([1000, 0.5])
  })

  it.each([999.9432090000046, 999.8321250000008])(
    'does not accept the retained subminimum wake %s',
    async (early) => {
      const clock = scriptedClock([early, 1000], 0)
      await waitForMinimum(1000, clock)
      expect(clock.elapsed()).toBe(1000)
      expect(clock.waits).toEqual([1000, 1000 - early])
    }
  )

  it('keeps checking repeated early wakes against the same deadline', async () => {
    const clock = scriptedClock([400, 900, 999.5, 999.75, 1000])
    await waitForMinimum(1000, clock)
    expect(clock.elapsed()).toBeGreaterThanOrEqual(1000)
    expect(clock.waits).toEqual([1000, 600, 100, 0.5, 0.25])
  })

  it('finishes at an exact hit without an extra wait', async () => {
    const clock = scriptedClock([1000])
    await waitForMinimum(1000, clock)
    expect(clock.elapsed()).toBe(1000)
    expect(clock.waits).toEqual([1000])
  })

  it('preserves an actual overshoot without rounding or clamping it', async () => {
    const clock = scriptedClock([1000.375])
    await waitForMinimum(1000, clock)
    expect(clock.elapsed()).toBe(1000.375)
    expect(clock.waits).toEqual([1000])
  })

  it('propagates a failed wait without proceeding', async () => {
    const failure = new Error('owned wait failed')
    let calls = 0
    await expect(
      waitForMinimum(1000, {
        now: () => 32768,
        wait: async () => {
          calls++
          throw failure
        }
      })
    ).rejects.toBe(failure)
    expect(calls).toBe(1)
  })
})
