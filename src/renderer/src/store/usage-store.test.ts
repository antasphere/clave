import { describe, it, expect } from 'vitest'
import {
  tightestWindow,
  shortLabel,
  formatReset,
  usageProviderForSession,
  headroomLabel,
  headroomWindow,
  accountUsageFieldsOf,
  claudeUsageForModel,
  capOutLabel,
  capStatus,
  capStatusLine,
  formatResetAt,
  type AccountUsageSummary
} from './usage-store'
import { isExhausted } from '../../../shared/account-pool'
import type { UsageWindow } from '../../../preload/index.d'

describe('focused session usage provider', () => {
  const local = {
    sessionType: 'local' as const,
    claudeMode: false,
    codexMode: false,
    antigravityMode: false
  }
  it('selects each agent, including Claude agents mode', () => {
    expect(usageProviderForSession({ ...local, claudeMode: true })).toBe('claude')
    expect(usageProviderForSession({ ...local, claudeAgentsMode: true })).toBe('claude')
    expect(usageProviderForSession({ ...local, claudeMode: true, codexMode: true })).toBe('codex')
    expect(usageProviderForSession({ ...local, claudeMode: true, piMode: true })).toBe('pi')
    expect(usageProviderForSession({ ...local, antigravityMode: true })).toBe('antigravity')
  })
  it('never assigns local account limits to terminal, file, or remote sessions', () => {
    expect(usageProviderForSession(local)).toBeNull()
    expect(usageProviderForSession(undefined)).toBeNull()
    expect(
      usageProviderForSession({ ...local, sessionType: 'remote-claude', claudeMode: true })
    ).toBeNull()
  })
})

/**
 * The auto-detection: which cap the foot of the sidebar names.
 *
 * This is the half that decides what the user reads, and it fails silently —
 * naming the wrong window still renders a plausible percentage, and nobody
 * would know until an agent stopped for a limit the sidebar never mentioned.
 */
function w(over: Partial<UsageWindow>): UsageWindow {
  return {
    key: 'k',
    label: 'L',
    kind: 'session',
    scope: null,
    usedPercentage: 0,
    resetsAt: null,
    severity: null,
    ...over
  }
}

describe('tightestWindow', () => {
  it('ignores exhausted Fable quota for an Opus session but retains shared quotas', () => {
    const windows = [
      w({ key: 'weekly', kind: 'weekly_all', usedPercentage: 30 }),
      w({
        key: 'fable',
        kind: 'weekly_scoped',
        scope: 'Fable',
        usedPercentage: 100,
        severity: 'critical'
      })
    ]
    expect(tightestWindow(windows, { model: 'claude-opus-5-5' })?.key).toBe('weekly')
    expect(tightestWindow(windows, { model: 'claude-fable-5' })?.key).toBe('fable')
    expect(tightestWindow(windows)?.key).toBe('fable')
  })

  it('requires model evidence for scoped caps and matches model tokens', () => {
    const windows = [
      w({ key: 'session', usedPercentage: 20 }),
      w({ key: 'fable', kind: 'weekly_scoped', scope: 'Fable', usedPercentage: 99 })
    ]
    for (const model of [undefined, '', 'default', 'sonnet', 'notfable']) {
      expect(tightestWindow(windows, { model })?.key).toBe('session')
    }
    for (const model of ['fable', 'FABLE', 'claude-fable-5[1m]']) {
      expect(tightestWindow(windows, { model })?.key).toBe('fable')
    }
  })

  it('is null when the service returned nothing', () => {
    expect(tightestWindow([])).toBeNull()
  })

  it('picks the window with the least left', () => {
    const picked = tightestWindow([
      w({ key: 'session', usedPercentage: 26 }),
      w({ key: 'weekly', kind: 'weekly_all', usedPercentage: 32 }),
      w({ key: 'fable', kind: 'weekly_scoped', scope: 'Fable', usedPercentage: 45 })
    ])
    expect(picked?.key).toBe('fable')
  })

  it("takes the service's severity over a bare percentage", () => {
    // The lower number is the one about to stop you: caps are plan-scoped and
    // a percentage of an unknown ceiling is not comparable across windows.
    const picked = tightestWindow([
      w({ key: 'high', usedPercentage: 80, severity: 'normal' }),
      w({ key: 'urgent', usedPercentage: 40, severity: 'critical' })
    ])
    expect(picked?.key).toBe('urgent')
  })
  it('takes a cap that is out over every open one, so the pool and the line agree', () => {
    // 96% used at normal severity has 4% left: out. The pool skips the
    // account, and the line says the same cap is out.
    const picked = tightestWindow([
      w({ key: 'block', kind: 'session', usedPercentage: 50, severity: 'warning' }),
      w({ key: 'week', kind: 'weekly_all', usedPercentage: 96, severity: 'normal' })
    ])
    expect(picked?.key).toBe('week')
  })

  it('falls back to the percentage within one severity', () => {
    const picked = tightestWindow([
      w({ key: 'a', usedPercentage: 40, severity: 'warning' }),
      w({ key: 'b', usedPercentage: 55, severity: 'warning' })
    ])
    expect(picked?.key).toBe('b')
  })

  it('treats a missing severity as normal rather than as urgent', () => {
    const picked = tightestWindow([
      w({ key: 'unknown', usedPercentage: 90, severity: null }),
      w({ key: 'warned', usedPercentage: 10, severity: 'warning' })
    ])
    expect(picked?.key).toBe('warned')
  })
})

describe('shortLabel', () => {
  it('names a scoped cap by its scope', () => {
    expect(shortLabel(w({ kind: 'weekly_scoped', scope: 'Fable' }))).toBe('Fable')
  })
  it('shortens the two known kinds', () => {
    expect(shortLabel(w({ kind: 'session' }))).toBe('5h')
    expect(shortLabel(w({ kind: 'weekly_all' }))).toBe('Overall')
  })
  it('falls back to the full label for a kind we have never seen', () => {
    // The service invents kinds; an unknown one must still read as words.
    expect(shortLabel(w({ kind: 'monthly_burst', label: 'Monthly burst' }))).toBe('Monthly burst')
  })
})

describe('headroomLabel', () => {
  it('says what is left of the tightest window, in the menu row’s words', () => {
    expect(
      headroomLabel({
        status: 'ready',
        tightest: w({ kind: 'session', usedPercentage: 28 }),
        error: null
      })
    ).toBe('72% left · 5h')
    expect(
      headroomLabel({
        status: 'ready',
        tightest: w({ kind: 'weekly_scoped', scope: 'Opus', usedPercentage: 91 }),
        error: null
      })
    ).toBe('9% left · Opus')
  })
  it('names the all-models weekly cap Overall when it ties with the tightest', () => {
    const session = w({ key: 'five_hour', kind: 'session', usedPercentage: 0 })
    const overall = w({ key: 'seven_day', kind: 'weekly_all', usedPercentage: 0.2 })
    expect(
      headroomLabel({
        status: 'ready',
        tightest: session,
        windows: [session, overall],
        error: null
      })
    ).toBe('100% left · Overall')
    const busy = w({ key: 'five_hour', kind: 'session', usedPercentage: 40 })
    expect(
      headroomLabel({ status: 'ready', tightest: busy, windows: [busy, overall], error: null })
    ).toBe('60% left · 5h')
  })
  it('never hands the line to a tied Overall when the tightest is the cap out that binds', () => {
    // Fable out for 5d, Overall out for 4d, both at 100% critical: the
    // session is stopped by Fable, and the foot must say so like the chip.
    const overallOut = w({
      key: 'seven_day',
      kind: 'weekly_all',
      usedPercentage: 100,
      severity: 'critical',
      resetsAt: 4_000
    })
    const fableOut = w({
      key: 'fable',
      kind: 'weekly_scoped',
      scope: 'Fable',
      usedPercentage: 100,
      severity: 'critical',
      resetsAt: 5_000
    })
    const onFable = claudeUsageForModel(
      { status: 'ready', error: null, ...accountUsageFieldsOf([overallOut, fableOut]) },
      'fable'
    )
    expect(onFable?.tightest).toBe(fableOut)
    expect(headroomWindow(onFable)).toBe(fableOut)
  })
  it('says nothing before a read, or after a failed one', () => {
    expect(headroomLabel(undefined)).toBeNull()
    expect(headroomLabel({ status: 'error', tightest: null, error: 'x' })).toBeNull()
  })
})

/**
 * The split in the renderer's own summary (PRDCT-4253) and the one
 * vocabulary for a cap that is out (PRDCT-4254). Romain's case of 9 November
 * 2026: the Fable week spent, 60% of the week left.
 */
const DAY = 86_400_000
const H = 3_600_000
const now = Date.UTC(2026, 10, 9, 12, 0, 0)
const overall = w({
  key: 'weekly',
  kind: 'weekly_all',
  label: 'Weekly · all models',
  usedPercentage: 40,
  resetsAt: now + 2 * DAY + 5 * H
})
const fable = w({
  key: 'fable',
  kind: 'weekly_scoped',
  scope: 'Fable',
  label: 'Weekly · Fable',
  usedPercentage: 100,
  severity: 'critical',
  resetsAt: now + 3 * DAY
})
const block = w({
  key: 'session',
  kind: 'session',
  label: 'Current session (5h)',
  usedPercentage: 20,
  resetsAt: now + 2 * H
})
const account: AccountUsageSummary = {
  status: 'ready',
  error: null,
  ...accountUsageFieldsOf([block, overall, fable])
}

describe('the account view and the session view of one read', () => {
  it('puts the tightest SHARED cap in tightest and the family that is out in scopedOut', () => {
    expect(account.tightest).toBe(overall)
    expect(account.shared).toBe(overall)
    expect(account.scopedOut).toEqual(['Fable'])
    expect(isExhausted(account)).toBe(false)
    expect(headroomLabel(account)).toBe('60% left · Overall')
  })
  it('is out for a session on Fable and open for one on Opus', () => {
    const onFable = claudeUsageForModel(account, 'claude-fable-5-1')!
    expect(onFable.tightest).toBe(fable)
    expect(onFable.shared).toBe(overall)
    expect(onFable.windows).toEqual([block, overall, fable])
    expect(isExhausted(onFable)).toBe(true)
    const onOpus = claudeUsageForModel(account, 'claude-opus-5-5')!
    expect(onOpus.tightest).toBe(overall)
    expect(onOpus.windows).toEqual([block, overall])
    expect(onOpus.scopedOut).toEqual([])
    expect(isExhausted(onOpus)).toBe(false)
    // The read's own fields ride along.
    expect(onOpus.status).toBe('ready')
  })
  it('leaves a failed read as it is', () => {
    const failed: AccountUsageSummary = { status: 'error', tightest: null, error: 'x' }
    expect(claudeUsageForModel(failed, 'opus')).toBe(failed)
  })
})

describe('the one vocabulary for a cap that is out', () => {
  it('names the cap and when it comes back, in or at', () => {
    expect(capOutLabel(fable, { now })).toBe('Fable out · back in 3d')
    expect(capOutLabel({ ...overall, usedPercentage: 100 }, { now })).toBe(
      'Overall out · back in 2d 5h'
    )
    expect(capOutLabel(block, { now, reset: 'at' })).toMatch(/^5h out · back \S/)
    // `at` is a date, never a distance.
    expect(capOutLabel(block, { now, reset: 'at' })).not.toMatch(/back in /)
    expect(capOutLabel(block, { now, reset: 'at' })).toBe(
      `5h out · back ${formatResetAt(block.resetsAt)}`
    )
    expect(capOutLabel({ ...fable, resetsAt: null })).toBe('Fable out')
  })
  it('names every cap of the view that is out, the one back last first', () => {
    // The 5-hour block out for 2h AND the week out for 2d 5h: the account is
    // out for 2d 5h, so the week is the stopping cap, and both are named.
    const blockOut = { ...block, usedPercentage: 100, severity: 'critical' as const }
    const weekOut = { ...overall, usedPercentage: 97, severity: 'warning' as const }
    const status = capStatus(
      { status: 'ready', error: null, ...accountUsageFieldsOf([blockOut, weekOut, fable]) },
      { now }
    )!
    expect(status.stopping).toBe(weekOut)
    expect(status.exhausted).toBe(true)
    // Then the others out in the read's order, the family that is out last.
    expect(status.out).toEqual([
      'Overall out · back in 2d 5h',
      '5h out · back in 2h',
      'Fable out · back in 3d'
    ])
    expect(status.headroom).toBeNull()
    // A session on Fable (back in 3d) with the week out behind it (2d 5h):
    // Fable binds, both are named, the chip and the notice say Fable.
    const account = {
      status: 'ready' as const,
      error: null,
      ...accountUsageFieldsOf([weekOut, fable])
    }
    const onFable = capStatus(claudeUsageForModel(account, 'fable'), { now })!
    expect(onFable.stopping).toBe(fable)
    expect(onFable.out).toEqual(['Fable out · back in 3d', 'Overall out · back in 2d 5h'])
    // The other way round: Fable back in 1d under a week out for 2d 5h, the
    // week binds and the session's stopping cap is Overall.
    const fableSoon = { ...fable, resetsAt: now + DAY }
    const weekBinds = capStatus(
      claudeUsageForModel(
        { status: 'ready', error: null, ...accountUsageFieldsOf([weekOut, fableSoon]) },
        'fable'
      ),
      { now }
    )!
    expect(weekBinds.stopping).toBe(weekOut)
    expect(weekBinds.out).toEqual(['Overall out · back in 2d 5h', 'Fable out · back in 1d'])
  })
  it('names a family once when two of its windows are out, back when the later one is', () => {
    // Codex's Spark bucket: its 5-hour block out for 2h and its week out for 5d.
    const codexWeek = w({ key: 'week', kind: 'weekly_all', usedPercentage: 30 })
    const sparkBlock = w({
      key: 'spark-5h',
      kind: 'session',
      scope: 'Spark',
      usedPercentage: 100,
      severity: 'critical',
      resetsAt: now + 2 * H
    })
    const sparkWeek = w({
      key: 'spark-7d',
      kind: 'weekly_scoped',
      scope: 'Spark',
      usedPercentage: 99,
      resetsAt: now + 5 * DAY
    })
    const account = {
      status: 'ready' as const,
      error: null,
      ...accountUsageFieldsOf([codexWeek, sparkBlock, sparkWeek])
    }
    expect(capStatusLine(account, { now })).toBe('70% left · Overall · Spark out · back in 5d')
    const onSpark = capStatus(claudeUsageForModel(account, 'gpt-5.3-codex-spark'), { now })!
    expect(onSpark.stopping).toBe(sparkWeek)
    expect(onSpark.out).toEqual(['Spark out · back in 5d'])
  })
  it('never names a cap out while the pool treats the view as open', () => {
    const block = w({ key: 'block', kind: 'session', usedPercentage: 50, severity: 'warning' })
    const week = w({
      key: 'week',
      kind: 'weekly_all',
      usedPercentage: 96,
      severity: 'normal',
      resetsAt: now + 4 * DAY
    })
    const account = {
      status: 'ready' as const,
      error: null,
      ...accountUsageFieldsOf([block, week])
    }
    expect(isExhausted(account)).toBe(true)
    expect(capStatusLine(account, { now })).toBe('Overall out · back in 4d')
  })
  it('names the families that are out even when the read has no shared cap', () => {
    const familiesOnly = { status: 'ready' as const, error: null, ...accountUsageFieldsOf([fable]) }
    expect(familiesOnly.tightest).toBeNull()
    expect(capStatus(familiesOnly, { now })).toEqual({
      headroom: null,
      out: ['Fable out · back in 3d'],
      stopping: null,
      exhausted: false
    })
    expect(capStatusLine(familiesOnly, { now })).toBe('Fable out · back in 3d')
  })
  it('reads the shared headroom first, then every family that is out, on an account', () => {
    expect(capStatus(account, { now })).toEqual({
      headroom: '60% left · Overall',
      out: ['Fable out · back in 3d'],
      stopping: null,
      exhausted: false
    })
    expect(capStatusLine(account, { now })).toBe('60% left · Overall · Fable out · back in 3d')
  })
  it('reads the shared cap out when it is, and says nothing of headroom', () => {
    const spent = {
      ...account,
      ...accountUsageFieldsOf([block, { ...overall, usedPercentage: 99 }, fable])
    }
    const status = capStatus(spent, { now })!
    expect(status.headroom).toBeNull()
    expect(status.stopping?.key).toBe('weekly')
    expect(status.exhausted).toBe(true)
    expect(status.out).toEqual(['Overall out · back in 2d 5h', 'Fable out · back in 3d'])
  })
  it('names the cap that stops THIS session on a session view, once', () => {
    const onFable = capStatus(claudeUsageForModel(account, 'claude-fable-5-1'), { now })!
    expect(onFable.stopping).toBe(fable)
    expect(onFable.exhausted).toBe(true)
    expect(onFable.out).toEqual(['Fable out · back in 3d'])
    // What the account still has for the other models.
    expect(onFable.headroom).toBe('60% left · Overall')
    const onOpus = capStatus(claudeUsageForModel(account, 'claude-opus-5-5'), { now })!
    expect(onOpus.stopping).toBeNull()
    expect(onOpus.out).toEqual([])
    expect(capStatusLine(claudeUsageForModel(account, 'claude-opus-5-5'), { now })).toBe(
      '60% left · Overall'
    )
  })
  it('says nothing before a read or after a failed one', () => {
    expect(capStatus(undefined)).toBeNull()
    expect(capStatus({ status: 'error', tightest: null, error: 'x' })).toBeNull()
    expect(capStatusLine({ status: 'loading', tightest: null, error: null })).toBeNull()
  })
})

describe('formatReset', () => {
  it('says nothing when the service did not', () => {
    expect(formatReset(null)).toBeNull()
  })
  it('counts days out past one', () => {
    expect(formatReset(Date.now() + 3 * 86_400_000)).toBe('resets in 3d')
  })
  it('counts hours and minutes inside a day', () => {
    expect(formatReset(Date.now() + 3 * 3_600_000 + 12 * 60_000)).toBe('resets in 3h12m')
  })
  it('never counts backwards on a window that already reset', () => {
    expect(formatReset(Date.now() - 60_000)).toBe('resets shortly')
  })
})
