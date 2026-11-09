import { describe, it, expect } from 'vitest'
import { explicitAccountId, isExhausted, pickAccount, switchTargets } from './account-pool'
import type { AccountUsageSummary } from '../store/usage-store'

function used(
  percent: number,
  extra: Partial<NonNullable<AccountUsageSummary['tightest']>> = {}
): AccountUsageSummary {
  return {
    status: 'ready',
    error: null,
    windows: [
      {
        key: 'session',
        label: 'Current session (5h)',
        kind: 'session',
        scope: null,
        usedPercentage: percent,
        resetsAt: null,
        severity: null
      }
    ],
    tightest: {
      key: 'session',
      label: 'Current session (5h)',
      kind: 'session',
      scope: null,
      usedPercentage: percent,
      resetsAt: null,
      severity: null,
      ...extra
    }
  }
}

const accounts = [
  { id: 'default', usable: true },
  { id: 'work', usable: true },
  { id: 'team', usable: true },
  { id: 'dead', usable: false }
]

/**
 * The rule that decides which subscription pays (ADR 0002). Every branch is
 * a wrong subscription when it is wrong, so each is pinned.
 */
describe('explicitAccountId', () => {
  it('keeps a named usable account even when its usage is exhausted', () => {
    expect(explicitAccountId(accounts, 'work')).toBe('work')
    expect(explicitAccountId(accounts, undefined)).toBeNull()
    expect(explicitAccountId(accounts, 'dead')).toBeNull()
  })
})

describe('isExhausted', () => {
  it('is about five percent left, or the service calling it critical', () => {
    expect(isExhausted(used(94))).toBe(false)
    expect(isExhausted(used(95))).toBe(true)
    expect(isExhausted(used(99.5))).toBe(true)
    expect(isExhausted(used(40, { severity: 'critical' }))).toBe(true)
    expect(isExhausted(used(40, { severity: 'warning' }))).toBe(false)
  })
  it('reads the view’s tightest window, which an account view never takes from a family cap', () => {
    // The summary builders (`usage-summary.ts`) put the tightest SHARED cap
    // in an account view’s `tightest`; a family that is out sits in `scopedOut`.
    const overall = { ...used(40).tightest!, key: 'weekly', kind: 'weekly_all' }
    const fable = {
      ...used(100).tightest!,
      key: 'fable',
      kind: 'weekly_scoped',
      scope: 'Fable',
      severity: 'critical' as const
    }
    const account: AccountUsageSummary = {
      status: 'ready',
      error: null,
      tightest: overall,
      shared: overall,
      windows: [overall, fable],
      scopedOut: ['Fable']
    }
    expect(isExhausted(account)).toBe(false)
    // The same read seen from a session on Fable.
    expect(isExhausted({ ...account, tightest: fable })).toBe(true)
  })
  it('never on a guess: no reading, or a failed one, is not exhaustion', () => {
    expect(isExhausted(undefined)).toBe(false)
    // The renderer's summary, as the store builds it, fits the pool's type.
    const failed: AccountUsageSummary = { status: 'error', error: 'x', tightest: null }
    const loading: AccountUsageSummary = { status: 'loading', error: null, tightest: null }
    expect(isExhausted(failed)).toBe(false)
    expect(isExhausted(loading)).toBe(false)
  })
})

describe('pickAccount', () => {
  it('keeps the preferred account while it has headroom', () => {
    expect(pickAccount({ accounts, usage: { work: used(10) }, preferredId: 'work' })).toBe('work')
    expect(pickAccount({ accounts, usage: {}, preferredId: 'team' })).toBe('team')
  })

  it('moves along the ring, from the preferred one, to the next with headroom', () => {
    const usage = { work: used(97), team: used(20) }
    expect(pickAccount({ accounts, usage, preferredId: 'work' })).toBe('team')
    // The ring wraps, and skips what cannot be started on.
    expect(pickAccount({ accounts, usage: { team: used(96) }, preferredId: 'team' })).toBe(
      'default'
    )
  })

  it('starts after the account being left, even when that one is the preferred', () => {
    const usage = { default: used(1), work: used(1), team: used(1) }
    expect(pickAccount({ accounts, usage, preferredId: 'work', leavingId: 'work' })).toBe('team')
    expect(pickAccount({ accounts, usage, preferredId: 'default', leavingId: 'team' })).toBe(
      'default'
    )
  })

  describe('ranks automatic switches by weekly headroom', () => {
    const weekly = (sessionUsed: number | null, weeklyUsed: number): AccountUsageSummary => {
      const session = sessionUsed === null ? [] : [used(sessionUsed).tightest!]
      const week = {
        ...used(0).tightest!,
        key: 'weekly',
        kind: 'weekly_all',
        usedPercentage: weeklyUsed
      }
      return { ...used(0), tightest: week, windows: [...session, week] }
    }
    const move = (usage: Record<string, AccountUsageSummary>): string =>
      pickAccount({
        accounts,
        usage,
        preferredId: 'default',
        leavingId: 'default',
        preferWeeklyHeadroom: true
      })
    it('takes the target with the most weekly headroom, whatever its 5-hour block says', () => {
      // Work's block is fresher, Team's week is: the week is what runs out.
      expect(move({ work: weekly(20, 80), team: weekly(60, 10) })).toBe('team')
    })
    it('uses the 5-hour block only to break a weekly tie, and only when every target has one', () => {
      expect(move({ work: weekly(60, 30), team: weekly(20, 30) })).toBe('team')
      // Team is a verified Ultra account: no 5-hour window since 30 October
      // 2026. The tie holds, and the ring's order decides.
      expect(move({ work: weekly(60, 30), team: weekly(null, 30) })).toBe('work')
    })
    it('ranks an Ultra account with no 5-hour window by its week like any other', () => {
      expect(move({ work: weekly(5, 50), team: weekly(null, 20) })).toBe('team')
      expect(move({ work: weekly(5, 20), team: weekly(null, 50) })).toBe('work')
    })
    it("ranks a session's view by the cap that binds its week: its family's when tighter", () => {
      const fable = (weeklyUsed: number, fableUsed: number): AccountUsageSummary => {
        const week = {
          ...used(0).tightest!,
          key: 'weekly',
          kind: 'weekly_all',
          usedPercentage: weeklyUsed
        }
        const family = {
          ...week,
          key: 'fable',
          kind: 'weekly_scoped',
          scope: 'Fable',
          usedPercentage: fableUsed
        }
        return { ...used(0), tightest: family, windows: [week, family] }
      }
      // Work has more of its week, Team more of its Fable cap: on Fable, Team.
      expect(move({ work: fable(30, 80), team: fable(50, 40) })).toBe('team')
    })
    it('puts a target with no weekly read last, and falls back to the ring with no reads at all', () => {
      expect(move({ work: used(10), team: weekly(10, 90) })).toBe('team')
      expect(move({})).toBe('work')
    })
  })

  it('takes a fallback only when every subscription account is out', () => {
    const withKey = [...accounts, { id: 'key', usable: true, fallback: true }]
    const usage = { default: used(96), work: used(96), team: used(96) }
    expect(pickAccount({ accounts: withKey, usage: { work: used(96) }, preferredId: 'work' })).toBe(
      'team'
    )
    expect(pickAccount({ accounts: withKey, usage, preferredId: 'work' })).toBe('key')
  })

  it('with everything out and no fallback, takes the account that resets soonest', () => {
    const usage = {
      default: used(96, { resetsAt: 3000 }),
      work: used(96, { resetsAt: 1000 }),
      team: used(96, { resetsAt: 2000 })
    }
    expect(pickAccount({ accounts, usage, preferredId: 'default' })).toBe('work')
  })

  it('never lands on an excluded account, and stays put with nowhere to go', () => {
    const one = [{ id: 'default', usable: true }]
    expect(
      pickAccount({ accounts: one, usage: { default: used(99) }, preferredId: 'default' })
    ).toBe('default')
    expect(
      pickAccount({
        accounts,
        usage: { work: used(99) },
        preferredId: 'work',
        excludeIds: ['team', 'default']
      })
    ).toBe('work')
  })
})

describe('switchTargets', () => {
  it('lists every other usable account, those with headroom first', () => {
    expect(switchTargets(accounts, { default: used(98), team: used(3) }, 'work')).toEqual([
      { id: 'team', exhausted: false, suggested: true, weeklyResetAt: null },
      { id: 'default', exhausted: true, suggested: false, weeklyResetAt: null }
    ])
  })

  it('suggests the open account whose weekly cap renews first', () => {
    const weekly = (percent: number, resetsAt: number): AccountUsageSummary => {
      const w = {
        key: 'seven_day',
        label: 'Weekly (all models)',
        kind: 'weekly_all',
        scope: null,
        usedPercentage: percent,
        resetsAt,
        severity: null
      }
      return { status: 'ready', error: null, windows: [w], tightest: w }
    }
    const targets = switchTargets(
      accounts,
      { work: weekly(40, 5_000), default: weekly(99, 1_000), team: weekly(10, 9_000) },
      'none'
    )
    expect(targets.map((t) => [t.id, t.suggested])).toEqual([
      ['work', true],
      ['team', false],
      ['default', false]
    ])
    expect(targets[0].weeklyResetAt).toBe(5_000)
  })
})

describe('recommended launch account', () => {
  const weekly = (percent: number, at: number): AccountUsageSummary => {
    const summary = used(percent)
    const window = { ...summary.tightest!, kind: 'weekly_all', resetsAt: at }
    return { ...summary, tightest: window, windows: [window] }
  }
  const input = {
    accounts,
    usage: { default: weekly(20, 9000), work: weekly(50, 3000), team: weekly(10, 6000) },
    preferredId: 'default',
    preferRecommended: true
  }
  it('uses the same weekly ranking as the switch menu when enabled', () => {
    expect(pickAccount(input)).toBe('work')
    expect(pickAccount({ ...input, preferRecommended: false })).toBe('default')
  })
  it('includes the selected account, and breaks ties in account order', () => {
    expect(pickAccount({ ...input, preferredId: 'work' })).toBe('work')
    expect(pickAccount({ ...input, usage: {}, preferredId: 'team' })).toBe('default')
  })
  it('skips exhausted, unusable, excluded and API key accounts', () => {
    expect(pickAccount({ ...input, usage: { ...input.usage, work: weekly(99, 1000) } })).toBe(
      'team'
    )
    expect(pickAccount({ ...input, excludeIds: ['work'] })).toBe('team')
    expect(
      pickAccount({
        ...input,
        accounts: [{ id: 'key', usable: true, fallback: true }, ...accounts],
        preferredId: 'key'
      })
    ).toBe('work')
    expect(
      pickAccount({ ...input, accounts: accounts.map((a) => ({ ...a, usable: a.id !== 'work' })) })
    ).toBe('team')
  })
  it('retains existing fallback when every subscription is exhausted', () => {
    const exhausted = { default: weekly(99, 3000), work: weekly(99, 1000), team: weekly(99, 2000) }
    expect(pickAccount({ ...input, usage: exhausted })).toBe('work')
    expect(
      pickAccount({
        ...input,
        usage: exhausted,
        accounts: [...accounts, { id: 'key', usable: true, fallback: true }]
      })
    ).toBe('key')
  })
})
