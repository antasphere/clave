import { describe, expect, it } from 'vitest'
import { limitOutLabel } from './limit-report-words'

const now = Date.UTC(2026, 10, 9, 12, 0, 0)
const fable = {
  key: 'fable',
  label: 'Weekly · Fable',
  kind: 'weekly_scoped',
  scope: 'Fable',
  usedPercentage: 100,
  severity: 'critical' as const,
  resetsAt: now + 2 * 86_400_000 + 5 * 3_600_000
}

describe('limitOutLabel', () => {
  it("names the cap the read shows out, in the readouts' words", () => {
    expect(limitOutLabel({ scope: 'shared' }, fable, now)).toBe('Fable out · back in 2d 5h')
  })
  it('names the family and the return the report gave before the read lands', () => {
    expect(limitOutLabel({ scope: { family: 'Fable' }, resetsAt: fable.resetsAt }, null, now)).toBe(
      'Fable out · back in 2d 5h'
    )
    expect(limitOutLabel({ scope: { family: 'Opus' } }, null, now)).toBe('Opus out')
  })
  it('says the bare word for the credits or an unnamed refusal, with the return when one is known', () => {
    expect(limitOutLabel({ scope: 'credits' }, null, now)).toBe('Out')
    expect(limitOutLabel({ scope: 'shared', resetsAt: now + 3_600_000 }, null, now)).toBe(
      'Out · back in 1h'
    )
    expect(limitOutLabel({ scope: 'unknown' }, null, now)).toBe('Out')
    expect(limitOutLabel(null, null, now)).toBe('Out')
  })
})
