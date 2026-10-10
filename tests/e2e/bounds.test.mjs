import { describe, it, expect, vi } from 'vitest'
import {
  SPEC_DEADLINE_MS,
  SPEC_DEADLINE_ENV,
  boundedClose,
  specDeadlineMs,
  withDeadline
} from './bounds.mjs'
import { CLOSE_TIMEOUT_MS } from './harness.mjs'
import { QUIT_CEILING_MS, QUIT_HAMMER_MS } from '../../src/main/quit-cleanup'

const never = new Promise(() => {})

describe('a spec deadline', () => {
  it('is the module’s own, else the environment’s, else the default', () => {
    expect(specDeadlineMs({}, {})).toBe(SPEC_DEADLINE_MS)
    expect(specDeadlineMs({ deadlineMs: 1500 }, {})).toBe(1500)
    expect(specDeadlineMs({}, { [SPEC_DEADLINE_ENV]: '2500' })).toBe(2500)
    expect(specDeadlineMs({ deadlineMs: 1500 }, { [SPEC_DEADLINE_ENV]: '2500' })).toBe(1500)
    // Nonsense never disables the bound.
    expect(specDeadlineMs({ deadlineMs: 0 }, { [SPEC_DEADLINE_ENV]: 'soon' })).toBe(
      SPEC_DEADLINE_MS
    )
    expect(specDeadlineMs({ deadlineMs: -1 }, {})).toBe(SPEC_DEADLINE_MS)
  })
})

describe('withDeadline', () => {
  it('answers the value when the promise settles first', async () => {
    expect(await withDeadline(Promise.resolve(42), 1000)).toEqual({ timedOut: false, value: 42 })
  })
  it('answers timedOut when it does not', async () => {
    expect(await withDeadline(never, 20)).toEqual({ timedOut: true })
  })
  it('propagates a rejection before the deadline', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom')
  })
  it('swallows a rejection after the deadline', async () => {
    let fail
    const late = new Promise((_, reject) => (fail = reject))
    const outcome = await withDeadline(late, 20)
    expect(outcome.timedOut).toBe(true)
    const unhandled = vi.fn()
    process.once('unhandledRejection', unhandled)
    fail(new Error('too late'))
    await new Promise((r) => setTimeout(r, 20))
    process.removeListener('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })
})

describe('boundedClose', () => {
  it('a close that returns in time kills nothing', async () => {
    const kill = vi.fn()
    const log = vi.fn()
    expect(await boundedClose(() => Promise.resolve(), 4242, 1000, { kill, log })).toEqual({
      timedOut: false
    })
    expect(kill).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
  it('a close that hangs ends with the exact pid killed and the log saying so', async () => {
    const kill = vi.fn()
    const log = vi.fn()
    let resolveClose
    const close = () =>
      new Promise((resolve) => {
        resolveClose = resolve
      })
    const killed = kill.mockImplementation(() => resolveClose())
    const outcome = await boundedClose(close, 4242, 50, { kill: killed, log })
    expect(outcome).toEqual({ timedOut: true })
    expect(kill).toHaveBeenCalledWith(4242)
    expect(log).toHaveBeenCalledWith(
      'app.close() did not return in 50 ms; killing Electron pid 4242'
    )
  })
  it('a kill that throws (the process already gone) is not an error', async () => {
    const kill = vi.fn(() => {
      throw new Error('ESRCH')
    })
    const log = vi.fn()
    const outcome = await boundedClose(() => never, 1, 30, { kill, log, afterKillMs: 30 })
    expect(outcome).toEqual({ timedOut: true })
    expect(log).toHaveBeenCalledWith('app.close() still pending after the kill of pid 1; moving on')
  })
})

describe('the bounds speak in order', () => {
  it('the app gives up before the harness does, so a stalled quit is named in the app log first', () => {
    expect(QUIT_CEILING_MS + QUIT_HAMMER_MS).toBeLessThan(CLOSE_TIMEOUT_MS)
  })
})
