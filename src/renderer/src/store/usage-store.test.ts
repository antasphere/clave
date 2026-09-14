import { describe, it, expect } from 'vitest'
import {
  tightestWindow,
  shortLabel,
  formatReset,
  usageProviderForSession,
  headroomLabel
} from './usage-store'
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
    expect(shortLabel(w({ kind: 'session' }))).toBe('session')
    expect(shortLabel(w({ kind: 'weekly_all' }))).toBe('weekly')
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
    ).toBe('72% left · session')
    expect(
      headroomLabel({
        status: 'ready',
        tightest: w({ kind: 'weekly_scoped', scope: 'Opus', usedPercentage: 91 }),
        error: null
      })
    ).toBe('9% left · Opus')
  })
  it('says nothing before a read, or after a failed one', () => {
    expect(headroomLabel(undefined)).toBeNull()
    expect(headroomLabel({ status: 'error', tightest: null, error: 'x' })).toBeNull()
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
