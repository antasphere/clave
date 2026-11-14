import { describe, expect, it } from 'vitest'
import {
  attributeUsage,
  OTHER_SESSIONS,
  rangeStart,
  rowKey,
  type LedgerLine,
  type UsageRecord
} from './usage-attribution'

// Made-up connections: two of one provider (Moonshot, Pi's `kimi-coding`).
const PROVIDER: Record<string, Record<string, string>> = {
  moonshot: { pi: 'kimi-coding', opencode: 'kimi-code-plan-global' },
  deepseek: { pi: 'clave-deepseek', opencode: 'deepseek' }
}
const providerOf = (company: string, harness: 'pi' | 'opencode'): string | undefined =>
  PROVIDER[company]?.[harness]

const NOW = new Date(2026, 10, 14, 18, 0, 0)
const at = (h: number, m = 0): number => new Date(2026, 10, 14, h, m, 0).getTime()

const line = (over: Partial<LedgerLine>): LedgerLine => ({
  harness: 'pi',
  sessionId: 's1',
  connectionId: null,
  label: null,
  company: null,
  at: at(9),
  ...over
})
const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  harness: 'pi',
  sessionId: 's1',
  at: at(10),
  provider: 'kimi-coding',
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: 0.01,
  ...over
})
const run = (
  records: UsageRecord[],
  ledger: LedgerLine[],
  range: 'today' | '7d' | '30d' | 'all' = 'today'
): ReturnType<typeof attributeUsage> =>
  attributeUsage({ records, ledger, range, now: NOW, providerOf })
const tokensOf = (
  rows: ReturnType<typeof run>,
  harness: 'pi' | 'opencode',
  id: string | null
): number => rows.get(rowKey(harness, id))?.figures.totalTokens ?? 0

describe('the rule of attribution (PRDCT-4551)', () => {
  it('counts a session moved from one connection to another at the time it moved', () => {
    const ledger = [
      line({ connectionId: 'kimi-a', label: 'Kimi A', company: 'moonshot', at: at(9) }),
      line({ connectionId: 'kimi-b', label: 'Kimi B', company: 'moonshot', at: at(12) })
    ]
    const rows = run(
      [
        rec({ at: at(10), totalTokens: 100 }),
        rec({ at: at(12), totalTokens: 7 }),
        rec({ at: at(13), totalTokens: 20 })
      ],
      ledger
    )
    expect(tokensOf(rows, 'pi', 'kimi-a')).toBe(100)
    // A record at the very moment of a line belongs to that line.
    expect(tokensOf(rows, 'pi', 'kimi-b')).toBe(27)
    expect(rows.get(rowKey('pi', 'kimi-b'))?.figures.requests).toBe(2)
  })

  it('counts a record of another provider to the harness sign-in, never to the connection', () => {
    const ledger = [line({ connectionId: 'kimi-a', label: 'Kimi A', company: 'moonshot' })]
    const rows = run(
      [rec({ provider: 'anthropic', totalTokens: 50 }), rec({ totalTokens: 5 })],
      ledger
    )
    expect(tokensOf(rows, 'pi', 'kimi-a')).toBe(5)
    expect(tokensOf(rows, 'pi', null)).toBe(50)
  })

  // The rule's three kinds (PRDCT-4551, the coordinator's correction): what
  // no line covers is "other sessions", never the sign-in.
  it('counts a session the ledger does not know, and a record from before its first line, to other sessions, never the sign-in', () => {
    const ledger = [
      line({ sessionId: 's2', connectionId: 'kimi-a', company: 'moonshot', at: at(11) }),
      line({ sessionId: 's3', connectionId: null, at: at(9) })
    ]
    const rows = run(
      [
        rec({ sessionId: 'unknown', totalTokens: 3 }),
        rec({ sessionId: 's2', at: at(10), totalTokens: 4 }),
        // A tab Clave started on no connection: its own sign-in.
        rec({ sessionId: 's3', at: at(10), totalTokens: 20 }),
        // Another provider while a tab named a connection: the sign-in too.
        rec({ sessionId: 's2', at: at(12), provider: 'anthropic', totalTokens: 100 }),
        // The connection's own.
        rec({ sessionId: 's2', at: at(12), totalTokens: 1000 })
      ],
      ledger
    )
    expect(tokensOf(rows, 'pi', OTHER_SESSIONS)).toBe(7)
    expect(tokensOf(rows, 'pi', null)).toBe(120)
    expect(tokensOf(rows, 'pi', 'kimi-a')).toBe(1000)
    expect(rows.get(rowKey('pi', OTHER_SESSIONS))?.figures.sessions).toBe(2)
  })

  it('never shares a record between two connections of one provider', () => {
    const ledger = [
      line({ sessionId: 'sa', connectionId: 'kimi-a', company: 'moonshot' }),
      line({ sessionId: 'sb', connectionId: 'kimi-b', company: 'moonshot' })
    ]
    const rows = run(
      [rec({ sessionId: 'sa', totalTokens: 11 }), rec({ sessionId: 'sb', totalTokens: 22 })],
      ledger
    )
    expect(tokensOf(rows, 'pi', 'kimi-a')).toBe(11)
    expect(tokensOf(rows, 'pi', 'kimi-b')).toBe(22)
    expect(rows.get(rowKey('pi', 'kimi-a'))?.figures.sessions).toBe(1)
  })

  it('keeps the harnesses apart: the same session id under OpenCode is another session', () => {
    const ledger = [line({ harness: 'opencode', connectionId: 'kimi-a', company: 'moonshot' })]
    const rows = run(
      [
        rec({ harness: 'opencode', provider: 'kimi-code-plan-global', totalTokens: 9 }),
        rec({ totalTokens: 1 })
      ],
      ledger
    )
    expect(tokensOf(rows, 'opencode', 'kimi-a')).toBe(9)
    // The Pi session of the same id is one the ledger does not know.
    expect(tokensOf(rows, 'pi', OTHER_SESSIONS)).toBe(1)
  })

  it('a line on no connection puts the session back on the sign-in from then on', () => {
    const ledger = [
      line({ connectionId: 'kimi-a', company: 'moonshot', at: at(9) }),
      line({ connectionId: null, at: at(11) })
    ]
    const rows = run(
      [rec({ at: at(10), totalTokens: 1 }), rec({ at: at(12), totalTokens: 2 })],
      ledger
    )
    expect(tokensOf(rows, 'pi', 'kimi-a')).toBe(1)
    expect(tokensOf(rows, 'pi', null)).toBe(2)
  })

  it('counts each range from its own start', () => {
    const ledger = [line({ connectionId: 'kimi-a', company: 'moonshot', at: 0 })]
    const day = 24 * 60 * 60 * 1000
    const records = [
      rec({ at: at(1), totalTokens: 1 }),
      rec({ at: NOW.getTime() - 3 * day, totalTokens: 10 }),
      rec({ at: NOW.getTime() - 20 * day, totalTokens: 100 }),
      rec({ at: NOW.getTime() - 60 * day, totalTokens: 1000 }),
      // After now: not counted in any range.
      rec({ at: NOW.getTime() + 60_000, totalTokens: 10000 })
    ]
    expect(tokensOf(run(records, ledger, 'today'), 'pi', 'kimi-a')).toBe(1)
    expect(tokensOf(run(records, ledger, '7d'), 'pi', 'kimi-a')).toBe(11)
    expect(tokensOf(run(records, ledger, '30d'), 'pi', 'kimi-a')).toBe(111)
    expect(tokensOf(run(records, ledger, 'all'), 'pi', 'kimi-a')).toBe(1111)
    expect(rangeStart('today', NOW)).toBe(new Date(2026, 10, 14).getTime())
  })
})
