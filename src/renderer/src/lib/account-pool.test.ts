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

  it("balances automatic switches using each account's 5-hour session headroom", () => {
    const usage = {
      work: {
        ...used(20),
        windows: [
          used(20).tightest!,
          { ...used(20).tightest!, key: 'weekly', kind: 'weekly_all', usedPercentage: 80 }
        ]
      },
      team: {
        ...used(60),
        windows: [
          used(60).tightest!,
          { ...used(60).tightest!, key: 'weekly', kind: 'weekly_all', usedPercentage: 10 }
        ]
      }
    }
    expect(
      pickAccount({
        accounts,
        usage,
        preferredId: 'default',
        leavingId: 'default',
        preferSessionHeadroom: true
      })
    ).toBe('work')
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
