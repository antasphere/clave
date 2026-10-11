import { describe, expect, it } from 'vitest'
import { backfillRows } from './backfill'
import { spansFromRows } from '../../shared/activity-fold'

const T0 = Date.parse('2026-09-01T10:00:00.000Z')
const iso = (offsetMin: number): string => new Date(T0 + offsetMin * 60_000).toISOString()
const NOW = T0 + 48 * 3_600_000
const identity = (sessionId: string, mode = 'claude', name = 'tab'): Record<string, unknown> => ({
  sessionId,
  name,
  mode,
  cwd: '/w',
  claudeSessionId: null,
  groupId: null,
  groupName: null,
  model: 'opus'
})

describe('backfillRows', () => {
  it('merges the capture and the ledger per tab into open, states and close', () => {
    const capture = [
      { kind: 'session_state', ts: iso(1), state: 'working', session: identity('a') },
      { kind: 'session_state', ts: iso(5), state: 'idle', session: identity('a') },
      { kind: 'message', ts: iso(6) },
      { kind: 'tab_closed', ts: iso(9), session: identity('a') }
    ]
    const ledger = [
      {
        kind: 'placed',
        ts: iso(0),
        sessionId: 'a',
        name: 'tab',
        cwd: '/w',
        mode: 'claude',
        model: null
      },
      {
        kind: 'placed',
        ts: iso(2),
        sessionId: 't',
        name: 'shell',
        cwd: '/w',
        mode: 'terminal',
        model: null
      },
      {
        kind: 'closed',
        ts: iso(30),
        sessionId: 't',
        name: 'shell',
        cwd: '/w',
        mode: 'terminal',
        model: null
      }
    ]
    const { rows, sessions } = backfillRows(capture, ledger, NOW)
    expect(sessions).toBe(2)
    expect(rows.every((r) => r.source === 'backfill')).toBe(true)
    const { spans } = spansFromRows(rows, NOW)
    const a = spans.find((s) => s.id === 'a')!
    expect(a.open).toBe(T0)
    expect(a.close).toBe(T0 + 9 * 60_000)
    expect(a.working).toEqual([[T0 + 60_000, T0 + 5 * 60_000]])
    expect(a.model).toBe('opus')
    const t = spans.find((s) => s.id === 't')!
    expect(t.tracked).toBe(false)
    expect(t.close).toBe(T0 + 30 * 60_000)
  })

  it('a tab with no close is cut at its last row, six hours later when it was working', () => {
    const capture = [
      { kind: 'session_state', ts: iso(0), state: 'working', session: identity('w') },
      { kind: 'session_state', ts: iso(0), state: 'working', session: identity('i') },
      { kind: 'session_state', ts: iso(3), state: 'idle', session: identity('i') }
    ]
    const { rows } = backfillRows(capture, [], NOW)
    const { spans } = spansFromRows(rows, NOW)
    expect(spans.find((s) => s.id === 'w')!.close).toBe(T0 + 6 * 3_600_000)
    expect(spans.find((s) => s.id === 'w')!.working).toEqual([[T0, T0 + 6 * 3_600_000]])
    expect(spans.find((s) => s.id === 'i')!.close).toBe(T0 + 3 * 60_000)
  })

  it('exited maps to ended, rows after now are dropped, malformed lines are skipped', () => {
    const capture = [
      { kind: 'session_state', ts: iso(0), state: 'working', session: identity('x') },
      { kind: 'session_state', ts: iso(2), state: 'exited', session: identity('x') },
      {
        kind: 'session_state',
        ts: new Date(NOW + 1).toISOString(),
        state: 'working',
        session: identity('x')
      },
      { kind: 'session_state', ts: 'bad', state: 'working', session: identity('y') },
      { kind: 'session_state', ts: iso(1), state: 'working' }
    ]
    const { rows, sessions } = backfillRows(capture, [], NOW)
    expect(sessions).toBe(1)
    expect(rows.filter((r) => r.kind === 'state').map((r) => r.state)).toEqual(['working', 'ended'])
    const { spans } = spansFromRows(rows, NOW)
    expect(spans[0].working).toEqual([[T0, T0 + 2 * 60_000]])
  })
})
