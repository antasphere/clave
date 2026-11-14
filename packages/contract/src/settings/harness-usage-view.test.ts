import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import {
  connectionUsageOf,
  harnessUsageText,
  signInUsageOf,
  type HarnessUsageRow
} from './harness-usage-view'
import { ReadHarnessUsage } from './index'

const figures = { requests: 12, totalTokens: 10_400, cost: 0.0137 }

describe('the one usage line of a connection (PRDCT-4551)', () => {
  it('says requests and tokens and NO cost on a coding plan or a local model', () => {
    expect(harnessUsageText(figures, 'plan', 'today')).toBe('12 requests · 10.4K tokens today')
    expect(harnessUsageText({ ...figures, requests: 1 }, 'local', '7d')).toBe(
      '1 request · 10.4K tokens in the last 7 days'
    )
    expect(harnessUsageText(figures, 'plan', 'today')).not.toContain('$')
  })

  it('says tokens and the cost the harness computed when paid per use, and for the sign-in', () => {
    expect(harnessUsageText(figures, 'payPerUse', 'today')).toBe('10.4K tokens · $0.01 today')
    expect(harnessUsageText(figures, 'signIn', '30d')).toBe(
      '10.4K tokens · $0.01 in the last 30 days'
    )
    expect(harnessUsageText({ requests: 0, totalTokens: 0, cost: 0 }, 'payPerUse', 'all')).toBe(
      '0 tokens · $0.00 in all'
    )
  })

  it("adds a connection's Pi and OpenCode rows, and finds a harness's sign-in", () => {
    const row = (over: Partial<HarnessUsageRow>): HarnessUsageRow => ({
      harness: 'pi',
      connectionId: 'c1',
      label: 'Kimi',
      billing: 'plan',
      removed: false,
      requests: 1,
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: 0,
      sessions: 1,
      ...over
    })
    const view = {
      rows: [
        row({}),
        row({ harness: 'opencode', requests: 2, totalTokens: 5 }),
        row({ connectionId: null, label: 'Pi sign-in', billing: 'signIn', totalTokens: 9 })
      ]
    }
    expect(connectionUsageOf(view, 'c1')).toMatchObject({
      billing: 'plan',
      figures: { requests: 3, totalTokens: 7 }
    })
    expect(connectionUsageOf(view, 'other')).toBeUndefined()
    expect(signInUsageOf(view, 'pi')?.totalTokens).toBe(9)
    expect(signInUsageOf(view, 'opencode')).toBeUndefined()
  })

  it('travels as the query answers it', () => {
    const success = ReadHarnessUsage.success as unknown as Schema.Schema<unknown, unknown>
    const view = {
      range: 'today',
      rows: [
        {
          harness: 'opencode',
          connectionId: null,
          label: 'OpenCode sign-in',
          billing: 'signIn',
          removed: false,
          requests: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: 0,
          sessions: 0
        }
      ],
      unavailable: [{ harness: 'opencode', reason: 'OpenCode is not installed here.' }]
    }
    expect(Schema.decodeUnknownSync(success)(Schema.encodeSync(success)(view))).toEqual(view)
  })
})
