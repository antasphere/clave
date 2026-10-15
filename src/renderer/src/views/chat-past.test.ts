import { describe, expect, it } from 'vitest'
import {
  PAST_RETRY_EVERY_MS,
  PAST_RETRY_FOR_MS,
  PAST_RETRY_MS,
  pastHead,
  pastStep,
  readPast,
  type PastClock
} from '../../../../plugins/chat-view/src/past'

/** A clock the test moves by hand: `advance` fires every timer due. */
function fakeClock(): PastClock & { advance(ms: number): Promise<void>; pending(): number } {
  let now = 0
  let next = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = ++next
      timers.set(id, { at: now + ms, run })
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id as number)
    },
    pending: () => timers.size,
    async advance(ms) {
      await flush()
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].run()
        await flush()
      }
      now = until
      await flush()
    }
  }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A read that fails `failures` times, then answers `value`. */
function flaky<T>(failures: number, value: T): { read: () => Promise<T>; calls: () => number } {
  let calls = 0
  return {
    read: () => {
      calls += 1
      return calls <= failures ? Promise.reject(new Error(`lost ${calls}`)) : Promise.resolve(value)
    },
    calls: () => calls
  }
}

describe('readPast (PRDCT-3526)', () => {
  it('reads the past once when the first answer comes', async () => {
    const clock = fakeClock()
    const source = flaky(0, ['a'])
    const got: unknown[] = []
    readPast(source.read, { read: (v) => got.push(v), failed: () => got.push('failed') }, clock)
    await flush()
    expect(got).toEqual([['a']])
    expect(source.calls()).toBe(1)
    expect(clock.pending()).toBe(0)
  })

  it('asks again after a lost answer, on the backoff, and reads it', async () => {
    const clock = fakeClock()
    const source = flaky(3, ['past'])
    const got: unknown[] = []
    readPast(source.read, { read: (v) => got.push(v), failed: () => got.push('failed') }, clock)
    await flush()
    expect(source.calls()).toBe(1)
    await clock.advance(PAST_RETRY_MS[0] - 1)
    expect(source.calls()).toBe(1)
    await clock.advance(1)
    expect(source.calls()).toBe(2)
    await clock.advance(PAST_RETRY_MS[1])
    expect(source.calls()).toBe(3)
    await clock.advance(PAST_RETRY_MS[2])
    expect(source.calls()).toBe(4)
    expect(got).toEqual([['past']])
  })

  it('an empty answer is final, not a failure', async () => {
    const clock = fakeClock()
    const source = flaky(0, [])
    const got: unknown[] = []
    readPast(source.read, { read: (v) => got.push(v), failed: () => got.push('failed') }, clock)
    await clock.advance(PAST_RETRY_FOR_MS)
    expect(got).toEqual([[]])
    expect(source.calls()).toBe(1)
  })

  it('says it failed once the round is spent, then waits for a retry', async () => {
    const clock = fakeClock()
    const source = flaky(Infinity, null)
    const failures: unknown[] = []
    const reader = readPast(source.read, { read: () => {}, failed: (e) => failures.push(e) }, clock)
    await clock.advance(PAST_RETRY_FOR_MS + PAST_RETRY_EVERY_MS)
    expect(failures).toHaveLength(1)
    const asked = source.calls()
    // The quarter-minute asks after the quick ones, inside the round.
    expect(asked).toBeGreaterThan(PAST_RETRY_MS.length + 1)
    await clock.advance(10 * PAST_RETRY_FOR_MS)
    expect(source.calls()).toBe(asked)
    reader.retry()
    await flush()
    expect(source.calls()).toBe(asked + 1)
  })

  it('a retry while waiting asks at once, and a reconnection after the failure starts a new round', async () => {
    const clock = fakeClock()
    const source = flaky(1, ['back'])
    const got: unknown[] = []
    const reader = readPast(
      source.read,
      { read: (v) => got.push(v), failed: () => got.push('failed') },
      clock
    )
    await flush()
    expect(source.calls()).toBe(1)
    reader.retry()
    await flush()
    expect(source.calls()).toBe(2)
    expect(got).toEqual([['back']])
    // Read: nothing more is asked, whatever happens.
    reader.retry()
    await clock.advance(PAST_RETRY_FOR_MS)
    expect(source.calls()).toBe(2)
  })

  it('takes no answer and leaves no timer after stop', async () => {
    const clock = fakeClock()
    let resolve: (v: string[]) => void = () => {}
    const got: unknown[] = []
    const reader = readPast(
      () => new Promise<string[]>((r) => (resolve = r)),
      { read: (v) => got.push(v), failed: () => got.push('failed') },
      clock
    )
    reader.stop()
    resolve(['late'])
    await flush()
    expect(got).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  it('a read that throws synchronously counts as a lost answer', async () => {
    const clock = fakeClock()
    let calls = 0
    const got: unknown[] = []
    readPast(
      () => {
        calls += 1
        if (calls === 1) throw new Error('no bridge yet')
        return Promise.resolve(['ok'])
      },
      { read: (v) => got.push(v), failed: () => got.push('failed') },
      clock
    )
    await clock.advance(PAST_RETRY_MS[0])
    expect(got).toEqual([['ok']])
  })

  it('a new round after a give-up has its own two minutes (round 1 of the verifier, F2)', async () => {
    const clock = fakeClock()
    const source = flaky(Infinity, null)
    const failures: unknown[] = []
    const reader = readPast(source.read, { read: () => {}, failed: (e) => failures.push(e) }, clock)
    await clock.advance(PAST_RETRY_FOR_MS + PAST_RETRY_EVERY_MS)
    expect(failures).toHaveLength(1)
    const before = source.calls()
    reader.retry()
    await clock.advance(30_000)
    // Still asking, quick waits first, and not given up after one more read.
    expect(failures).toHaveLength(1)
    expect(source.calls() - before).toBeGreaterThan(3)
    await clock.advance(PAST_RETRY_FOR_MS)
    expect(failures).toHaveLength(2)
  })

  it('leaves no timer when stopped while a retry is waiting (F3)', async () => {
    const clock = fakeClock()
    const source = flaky(Infinity, null)
    const reader = readPast(source.read, { read: () => {}, failed: () => {} }, clock)
    await clock.advance(PAST_RETRY_MS[0] + PAST_RETRY_MS[1] + 10)
    expect(clock.pending()).toBe(1)
    const asked = source.calls()
    reader.stop()
    expect(clock.pending()).toBe(0)
    await clock.advance(PAST_RETRY_FOR_MS)
    expect(source.calls()).toBe(asked)
  })
})

describe("the transcript's head (PRDCT-3526, round 1 of the verifier, F1)", () => {
  it('invites to start only over a past actually read and empty', () => {
    expect(pastHead('read', 0, false)).toBe('empty')
    expect(pastHead('read', 3, false)).toBe(null)
    expect(pastHead('read', 0, true)).toBe(null)
  })
  it('says nothing while asking, a Retry round included, even with no entry', () => {
    expect(pastHead('reading', 0, false)).toBe(null)
  })
  it('says the failure, never the invitation, when the round found no answer', () => {
    expect(pastHead('failed', 0, false)).toBe('failed')
    expect(pastHead('failed', 4, false)).toBe('failed')
  })
})

describe("the pane's past state (round 2 of the verifier, G2)", () => {
  it('a Retry after a failure goes back to reading, so neither head shows', () => {
    const after = pastStep('failed', 'retry')
    expect(after).toBe('reading')
    expect(pastHead(after, 0, false)).toBe(null)
  })
  it('an answer reads it, a spent round fails it', () => {
    expect(pastStep('reading', 'read')).toBe('read')
    expect(pastStep('reading', 'failed')).toBe('failed')
    expect(pastStep('failed', 'read')).toBe('read')
  })
  it('once read, nothing moves it', () => {
    expect(pastStep('read', 'failed')).toBe('read')
    expect(pastStep('read', 'retry')).toBe('read')
  })
})
