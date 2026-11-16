import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessUsageView } from '@clave/contract/settings/harness-usage-view'
import {
  connectionUsage,
  connectionUsageLineFor,
  HARNESS_USAGE_REREAD_MS,
  ensureHarnessUsage,
  harnessUsageFor,
  refreshHarnessUsage,
  setHarnessUsageReader,
  signInUsage
} from './harness-usage-store'

const row = (over: Record<string, unknown>): HarnessUsageView['rows'][number] =>
  ({
    harness: 'pi',
    connectionId: null,
    label: 'x',
    billing: 'plan',
    removed: false,
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    sessions: 0,
    ...over
  }) as never

const VIEW: HarnessUsageView = {
  range: 'today',
  rows: [
    row({ connectionId: 'kimi', requests: 2, totalTokens: 1000 }),
    row({ harness: 'opencode', connectionId: 'kimi', requests: 1, totalTokens: 500 }),
    row({ connectionId: 'ds', billing: 'payPerUse', requests: 1, totalTokens: 50, cost: 0.123 }),
    row({ connectionId: 'gone', removed: true, requests: 4, totalTokens: 4 }),
    row({ billing: 'signIn', requests: 1, totalTokens: 7, cost: 0.004 })
  ],
  unavailable: []
}

// The verifier's N1: the sidebar's foot reads the sign-in through
// `signInUsage`; "Other sessions" carries a null connectionId too.
describe('the sign-in the window reads is never "Other sessions" (PRDCT-4551)', () => {
  const other = row({ label: 'Other sessions', other: true, requests: 9, totalTokens: 999 })
  const signIn = row({ label: 'Pi sign-in', billing: 'signIn', requests: 1, totalTokens: 7 })
  const entryOf = (rows: HarnessUsageView['rows']): Parameters<typeof signInUsage>[0] =>
    ({ view: { range: 'today', rows, unavailable: [] } }) as never

  it('answers the sign-in listed after "Other sessions", and nothing when only that row is there', () => {
    expect(signInUsage(entryOf([other, signIn]), 'pi')?.line).toBe('1 request · 7 tokens today')
    expect(signInUsage(entryOf([other]), 'pi')).toBeUndefined()
  })
})

describe('the usage per connection the window keeps (PRDCT-4551)', () => {
  const read = vi.fn(
    async (_machine: string, range: string) => ({ ...VIEW, range }) as HarnessUsageView
  )
  beforeEach(() => {
    read.mockClear()
    setHarnessUsageReader(read)
  })

  it('reads a machine once while fresh, again when forced, and answers each line', async () => {
    await ensureHarnessUsage('local', 'today')
    await ensureHarnessUsage('local', 'today')
    expect(read).toHaveBeenCalledTimes(1)
    await ensureHarnessUsage('local', 'today', { force: true })
    expect(read).toHaveBeenCalledTimes(2)
    const entry = harnessUsageFor('local')
    expect(connectionUsage(entry, 'kimi')?.line).toBe('3 requests · 1.5K tokens today')
    expect(connectionUsage(entry, 'ds')?.line).toBe('50 tokens · $0.12 today')
    expect(signInUsage(entry, 'pi')?.line).toBe('1 request · 7 tokens today')
    expect(signInUsage(entry, 'opencode')).toBeUndefined()
    // A removed connection is Settings → Usage's alone.
    expect(connectionUsage(entry, 'gone')).toBeUndefined()
    expect(connectionUsageLineFor('local', 'kimi')).toBe('3 requests · 1.5K tokens today')
    expect(connectionUsageLineFor('elsewhere', 'kimi')).toBeNull()
  })

  it('reads again, on Refresh or a turn end, every machine and range already asked for', async () => {
    await ensureHarnessUsage('local', 'today')
    await ensureHarnessUsage('server-1', '7d')
    read.mockClear()
    await refreshHarnessUsage('server-1')
    expect(read.mock.calls).toEqual([['server-1', '7d']])
    await refreshHarnessUsage()
    expect(read).toHaveBeenCalledTimes(3)
  })

  // The coordinator's point 3: a place draws at once and fills in.
  it('says Reading… before the first answer and beside the figure while the host still reads, and asks again', async () => {
    vi.useFakeTimers()
    try {
      let reading = true
      read.mockImplementation(
        async (_m: string, range: string) =>
          ({ ...VIEW, range, reading: reading ? ['opencode'] : [] }) as HarnessUsageView
      )
      const pending = ensureHarnessUsage('local', 'today')
      expect(connectionUsageLineFor('local', 'kimi')).toBe('Reading…')
      await pending
      expect(connectionUsageLineFor('local', 'kimi')).toBe(
        '3 requests · 1.5K tokens today · Reading…'
      )
      reading = false
      expect(read).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(HARNESS_USAGE_REREAD_MS)
      expect(read).toHaveBeenCalledTimes(2)
      expect(connectionUsageLineFor('local', 'kimi')).toBe('3 requests · 1.5K tokens today')
      await vi.advanceTimersByTimeAsync(HARNESS_USAGE_REREAD_MS * 3)
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
      read.mockImplementation(
        async (_machine: string, range: string) => ({ ...VIEW, range }) as HarnessUsageView
      )
    }
  })

  it('keeps the last answer through a failed read', async () => {
    await ensureHarnessUsage('local', 'today')
    read.mockRejectedValueOnce(new Error('down'))
    await ensureHarnessUsage('local', 'today', { force: true })
    expect(harnessUsageFor('local')?.status).toBe('error')
    expect(connectionUsageLineFor('local', 'kimi')).toBe('3 requests · 1.5K tokens today')
  })
})
