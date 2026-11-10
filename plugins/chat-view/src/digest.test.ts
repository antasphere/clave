import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIGEST_RETRY_AFTER_MS, DIGEST_SETTLE_MS, createDigests, digestFailureLine } from './digest'

/**
 * A digest that could not be read (PRDCT-4327): the card's state carries the
 * reason, a view asking again a moment later does not re-ask it, its "Ask
 * again" asks at once, and a view asking after DIGEST_RETRY_AFTER_MS re-asks
 * it on its own. A failure is no longer final for the run of the app.
 */
type Answer = { ok: true; title: string } | { ok: false; error: string; reason?: 'limit' }

let answers: Answer[] = []
const read = vi.fn((): Promise<Answer> => Promise.resolve(answers.shift()!))
const digests = (): ReturnType<typeof createDigests<string, { ok: true; title: string }>> =>
  createDigests<string, { ok: true; title: string }>({
    filed: () => Promise.resolve({}),
    read
  })
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  read.mockClear()
  answers = []
})
afterEach(() => vi.useRealTimers())

describe('a digest that could not be read', () => {
  it('says why, is not re-asked at once, and its Ask again reads it', async () => {
    const d = digests()
    const item = { key: 'k', payload: 'notes' }
    d.useStore.getState().file('s', {})
    answers.push({ ok: false, error: 'You have hit your limit', reason: 'limit' })
    d.view('s', [item], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
    await flush()
    expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'failed', reason: 'limit' })
    // The view asking again a moment later: no new call for a fresh failure.
    d.view('s', [item], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
    expect(read).toHaveBeenCalledTimes(1)
    // Ask again: read at once, and the card takes the answer.
    answers.push({ ok: true, title: 'Read' })
    d.retry('s', 'k')
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'done', fresh: true })
  })

  it('a stale failure is re-asked when the view asks again', async () => {
    const d = digests()
    const item = { key: 'k', payload: 'notes' }
    d.useStore.getState().file('s', {})
    answers.push({ ok: false, error: 'boom' })
    d.view('s', [item], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
    await flush()
    expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'failed' })
    await vi.advanceTimersByTimeAsync(DIGEST_RETRY_AFTER_MS)
    answers.push({ ok: true, title: 'Read' })
    d.view('s', [item], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'done' })
  })

  it('a thrown call reads as the server not answering', async () => {
    const d = createDigests<string, { ok: true }>({
      filed: () => Promise.resolve({}),
      read: () => Promise.reject(new Error('unreachable'))
    })
    d.useStore.getState().file('s', {})
    d.view('s', [{ key: 'k', payload: '' }], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
    await flush()
    expect(d.useStore.getState().states['s|k']).toMatchObject({
      state: 'failed',
      reason: 'unanswered'
    })
  })

  it('says the class of the reason in one line', () => {
    expect(digestFailureLine('limit')).toBe('Not read: the account is at its limit.')
    expect(digestFailureLine('auth')).toBe('Not read: the account is not signed in.')
    expect(digestFailureLine('timeout')).toBe('Not read: the read timed out.')
    expect(digestFailureLine('disabled')).toBe('Not read: this helper is switched off.')
    expect(digestFailureLine(undefined)).toBe('Not read.')
  })
})
