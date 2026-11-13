import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DIGEST_BUSY_RETRY_MS,
  DIGEST_GIVE_UP_MS,
  DIGEST_RETRY_AFTER_MS,
  DIGEST_SETTLE_MS,
  canAskAgain,
  createDigests,
  digestFailureLine
} from './digest'

/**
 * A digest that could not be read (PRDCT-4327): the card's state carries the
 * reason, a view asking again a moment later does not re-ask it, its "Ask
 * again" asks at once, and a view asking after DIGEST_RETRY_AFTER_MS re-asks
 * it on its own. A failure is no longer final for the run of the app.
 */
type Answer =
  | { ok: true; title: string }
  | {
      ok: false
      error: string
      reason?:
        | 'limit'
        | 'timeout'
        | 'outdated'
        | 'unknown-session'
        | 'disabled'
        | 'refused'
        | 'failed'
        | 'busy'
    }

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
    answers.push({ ok: false, error: 'boom', reason: 'timeout' })
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

  it('says the class of the reason in words for anyone, Not read on a timeline, No title on a work card', () => {
    const lines = {
      timeout: 'Not read: it took too long.',
      auth: 'Not read: this account is signed out.',
      limit: 'Not read: this account is at its limit.',
      unreadable: 'Not read: the answer could not be used.',
      cancelled: 'Not read: the read was stopped.',
      disabled: 'Not read: digests are switched off in Settings.',
      failed: 'Not read: something went wrong.',
      unanswered: 'Not read: the server did not answer.'
    } as const
    for (const [reason, line] of Object.entries(lines))
      expect(digestFailureLine(reason as keyof typeof lines)).toBe(line)
    expect(digestFailureLine(undefined)).toBe('Not read: something went wrong.')
    expect(digestFailureLine('limit', 'work')).toBe('No title: this account is at its limit.')
    expect(digestFailureLine('disabled', 'work')).toBe(
      'No title: titles are switched off in Settings.'
    )
  })

  it("the view's own patience is not a failure: the card says it is taking long and the late answer lands", async () => {
    let answer: (value: Answer) => void = () => {}
    const d = createDigests<string, { ok: true; title: string }>({
      filed: () => Promise.resolve({}),
      read: () => new Promise<Answer>((resolve) => (answer = resolve))
    })
    d.useStore.getState().file('s', {})
    d.view('s', [{ key: 'k', payload: '' }], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS + DIGEST_GIVE_UP_MS)
    expect(d.useStore.getState().states['s|k']).toEqual({ state: 'reading', slow: true })
    answer({ ok: true, title: 'Late' })
    await flush()
    expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'done', fresh: true })
  })

  for (const reason of ['outdated', 'unknown-session', 'disabled', 'refused'] as const)
    it(`a failure no ask can mend (${reason}) is not asked again, by the view or by Ask again`, async () => {
      const d = digests()
      const item = { key: 'k', payload: 'notes' }
      d.useStore.getState().file('s', {})
      answers.push({ ok: false, error: 'x', reason })
      d.view('s', [item], {})
      await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
      await flush()
      expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'failed', reason })
      expect(canAskAgain(reason)).toBe(false)
      d.retry('s', 'k')
      await vi.advanceTimersByTimeAsync(DIGEST_RETRY_AFTER_MS)
      d.view('s', [item], {})
      await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
      expect(read).toHaveBeenCalledTimes(1)
    })

  it('says the three host and client cases apart', () => {
    expect(digestFailureLine('outdated')).toBe('Not read: this server needs an update.')
    expect(digestFailureLine('unknown-session')).toBe(
      'Not read: the server no longer has this tab.'
    )
    expect(digestFailureLine('busy')).toBe(
      'Not read: too many are being read; ask again in a moment.'
    )
    expect(digestFailureLine('outdated', 'work')).toBe('No title: this server needs an update.')
    expect(digestFailureLine('refused')).toBe('Not read: this could not be read.')
    expect(digestFailureLine('refused', 'work')).toBe('No title: this could not be read.')
    for (const reason of [
      'timeout',
      'limit',
      'auth',
      'unreadable',
      'cancelled',
      'unanswered',
      'busy',
      'failed'
    ] as const)
      expect(canAskAgain(reason)).toBe(true)
    for (const reason of ['disabled', 'refused', 'outdated', 'unknown-session', undefined] as const)
      expect(canAskAgain(reason)).toBe(false)
  })

  it('when the window’s server comes, the filed digests are read again and a card that failed for want of it is asked again', async () => {
    let connected: () => void = () => {}
    const previous = (globalThis as { window?: unknown }).window
    Object.assign(globalThis, {
      window: {
        electronAPI: {
          onServerConnected: (callback: () => void) => {
            connected = callback
            return () => {}
          }
        }
      }
    })
    try {
      // What the server has filed for the tab: read when it comes.
      const d = createDigests<string, { ok: true; title: string }>({
        filed: () => Promise.resolve({ other: { ok: true, title: 'Filed' } }),
        read: () =>
          read.mock.calls.length === 0
            ? (read(), Promise.reject(new Error('no server')))
            : (read(), Promise.resolve({ ok: true, title: 'Now' }))
      })
      d.useStore.getState().file('s', {})
      d.view('s', [{ key: 'k', payload: '' }], {})
      await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
      await flush()
      expect(d.useStore.getState().states['s|k']).toMatchObject({
        state: 'failed',
        reason: 'unanswered'
      })
      connected()
      await vi.advanceTimersByTimeAsync(0)
      await flush()
      expect(read).toHaveBeenCalledTimes(2)
      expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'done' })
      expect(d.useStore.getState().states['s|other']).toMatchObject({ state: 'done' })
    } finally {
      Object.assign(globalThis, { window: previous })
    }
  })

  it('a runner failure (an overloaded API, a crash) keeps Ask again, and is asked again by itself once stale', async () => {
    const d = digests()
    const item = { key: 'k', payload: 'notes' }
    d.useStore.getState().file('s', {})
    answers.push({ ok: false, error: 'API Error: 529 overloaded', reason: 'failed' })
    d.view('s', [item], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
    await flush()
    expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'failed', reason: 'failed' })
    expect(canAskAgain('failed')).toBe(true)
    // Ask again reads it at once…
    answers.push({ ok: false, error: 'API Error: 529 overloaded', reason: 'failed' })
    d.retry('s', 'k')
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    // …and a view asking a minute later asks again by itself.
    answers.push({ ok: true, title: 'Read' })
    await vi.advanceTimersByTimeAsync(DIGEST_RETRY_AFTER_MS)
    d.view('s', [item], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
    await flush()
    expect(read).toHaveBeenCalledTimes(3)
    expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'done' })
  })
})

describe('a read the host found busy', () => {
  it('is asked again by itself after DIGEST_BUSY_RETRY_MS, with no new view', async () => {
    expect(DIGEST_BUSY_RETRY_MS).toBe(4_000)
    const d = digests()
    const item = { key: 'k', payload: 'q' }
    d.useStore.getState().file('s', {})
    answers.push({ ok: false, error: 'Too many reads', reason: 'busy' })
    d.view('s', [item], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
    await flush()
    expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'failed', reason: 'busy' })
    answers.push({ ok: true, title: 'Read' })
    await vi.advanceTimersByTimeAsync(DIGEST_BUSY_RETRY_MS - 1)
    expect(read).toHaveBeenCalledTimes(1)
    // The timer, then the ask it makes at once.
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'done', fresh: true })
  })

  it('is not asked again once its card left the view', async () => {
    const d = digests()
    const item = { key: 'k', payload: 'q' }
    d.useStore.getState().file('s', {})
    answers.push({ ok: false, error: 'Too many reads', reason: 'busy' })
    d.view('s', [item], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
    await flush()
    d.view('s', [], {})
    await vi.advanceTimersByTimeAsync(DIGEST_BUSY_RETRY_MS * 3)
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    // Not even asked: the card keeps its failure, as it was left.
    expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'failed', reason: 'busy' })
  })

  it('is re-asked by a view asking after DIGEST_BUSY_RETRY_MS, not after a minute', async () => {
    const d = digests()
    const item = { key: 'k', payload: 'q' }
    d.useStore.getState().file('s', {})
    answers.push({ ok: false, error: 'Too many reads', reason: 'busy' })
    d.view('s', [item], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
    await flush()
    // Out of view (its own timer cleared), back in view 4 s later.
    d.view('s', [], {})
    await vi.advanceTimersByTimeAsync(DIGEST_BUSY_RETRY_MS)
    answers.push({ ok: true, title: 'Read' })
    d.view('s', [item], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS)
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('a family that asks at once', () => {
  it('reads a card with no settle wait when its family says so (the page titles)', async () => {
    const d = createDigests<string, { ok: true; title: string }>({
      filed: () => Promise.resolve({}),
      read,
      settleMs: 0
    })
    d.useStore.getState().file('s', {})
    answers.push({ ok: true, title: 'Now' })
    d.view('s', [{ key: 'k', payload: 'q' }], {})
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(d.useStore.getState().states['s|k']).toMatchObject({ state: 'done', fresh: true })
  })

  it('waits DIGEST_SETTLE_MS by default', async () => {
    const d = digests()
    d.useStore.getState().file('s', {})
    answers.push({ ok: true, title: 'Later' })
    d.view('s', [{ key: 'k', payload: 'q' }], {})
    await vi.advanceTimersByTimeAsync(DIGEST_SETTLE_MS - 1)
    expect(read).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
  })
})
