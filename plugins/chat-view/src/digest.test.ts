import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
  | { ok: false; error: string; reason?: 'limit' | 'outdated' | 'unknown-session' }

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

  for (const reason of ['outdated', 'unknown-session'] as const)
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
    expect(canAskAgain('busy')).toBe(true)
    expect(canAskAgain('limit')).toBe(true)
  })
})
