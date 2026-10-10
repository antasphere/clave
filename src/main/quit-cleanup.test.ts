import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUIT_CEILING_MS, QUIT_HAMMER_MS, awaitQuitWaits } from './quit-cleanup'

// Fake timers: the ceiling is driven by hand, so a wait that never settles
// costs the test nothing.
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const never = new Promise<void>(() => {})

describe('the quit cleanup is bounded, and names what it waited on', () => {
  it('resolves as soon as every wait settled, with nothing pending and nothing logged', async () => {
    const log = vi.fn()
    let settle!: () => void
    const outcome = awaitQuitWaits(
      [
        { name: "the sessions' shutdown", promise: Promise.resolve() },
        { name: "the server's stop", promise: new Promise<void>((r) => (settle = r)) }
      ],
      { ceilingMs: 8000, log }
    )
    await vi.advanceTimersByTimeAsync(300)
    settle()
    expect(await outcome).toMatchObject({ pending: [] })
    expect(log).not.toHaveBeenCalled()
  })

  it('past the ceiling it names the wait still pending in the log and resolves anyway', async () => {
    const log = vi.fn()
    const outcome = awaitQuitWaits(
      [
        { name: "the sessions' shutdown", promise: Promise.resolve() },
        { name: "the server's stop", promise: never }
      ],
      { ceilingMs: 8000, log }
    )
    await vi.advanceTimersByTimeAsync(7999)
    expect(log).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    const result = await outcome
    expect(result.pending).toEqual(["the server's stop"])
    expect(result.ms).toBe(8000)
    expect(log).toHaveBeenCalledWith(
      "[quit] still waiting after 8000 ms on: the server's stop; quitting anyway"
    )
  })

  it('names every pending wait when none settled', async () => {
    const log = vi.fn()
    const outcome = awaitQuitWaits(
      [
        { name: "the sessions' shutdown", promise: never },
        { name: "the server's stop", promise: never }
      ],
      { ceilingMs: 100, log }
    )
    await vi.advanceTimersByTimeAsync(100)
    expect((await outcome).pending).toEqual(["the sessions' shutdown", "the server's stop"])
    expect(log.mock.calls[0][0]).toContain("the sessions' shutdown, the server's stop")
  })

  it('a wait that fails is settled, logged with its name, and never thrown', async () => {
    const log = vi.fn()
    const outcome = awaitQuitWaits(
      [{ name: "the server's stop", promise: Promise.reject(new Error('listener gone')) }],
      { ceilingMs: 8000, log }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect((await outcome).pending).toEqual([])
    expect(log).toHaveBeenCalledWith("[quit] the server's stop failed: Error: listener gone")
  })

  it('no waits at all resolves at once', async () => {
    const outcome = awaitQuitWaits([], { ceilingMs: 8000, log: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    expect((await outcome).pending).toEqual([])
  })

  it('the ceiling stays under the harness bound and the hammer close behind it', () => {
    // tests/e2e/harness.mjs bounds app.close() at CLOSE_TIMEOUT_MS; the app
    // must give up first, so the log names the wait before the harness kills it.
    expect(QUIT_CEILING_MS + QUIT_HAMMER_MS).toBeLessThan(25_000)
    expect(QUIT_HAMMER_MS).toBeLessThanOrEqual(QUIT_CEILING_MS)
  })
})
