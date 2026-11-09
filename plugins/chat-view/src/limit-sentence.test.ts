import { describe, expect, it } from 'vitest'
import { limitSentence } from './limit-sentence'

/** The ended notice's first sentence (PRDCT-4254, PRDCT-4302): the account,
 *  the cap that is out and when it comes back; never "out of usage credits". */
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

describe('limitSentence', () => {
  it('names the account, the cap and the return when the cap is known', () => {
    expect(limitSentence('Work', fable, null, now)).toBe('Work is out on Fable, back in 2d 5h.')
    expect(limitSentence('Work', { ...fable, resetsAt: null }, null, now)).toBe(
      'Work is out on Fable.'
    )
    expect(limitSentence('Work', { ...fable, kind: 'weekly_all', scope: null }, null, now)).toBe(
      'Work is out on Overall, back in 2d 5h.'
    )
    // The read wins over the report's word.
    expect(limitSentence('Work', fable, { scope: 'credits' }, now)).toBe(
      'Work is out on Fable, back in 2d 5h.'
    )
  })
  it("names the family and the return the CLI's report gave, before the read shows a cap out", () => {
    expect(
      limitSentence('Work', null, { scope: { family: 'Fable' }, resetsAt: fable.resetsAt }, now)
    ).toBe('Work is out on Fable, back in 2d 5h.')
    expect(limitSentence('Work', null, { scope: { family: 'Opus' } }, now)).toBe(
      'Work is out on Opus.'
    )
  })
  it("says the credits when the CLI's reply was the org's, and the report alone otherwise", () => {
    expect(limitSentence('Work', null, { scope: 'credits' }, now)).toBe('Work is out of credits.')
    expect(limitSentence('team@antasphere.com', null, null, now)).toBe(
      'team@antasphere.com is out, as its agent reported.'
    )
    expect(limitSentence('Work', null, { scope: 'shared' }, now)).toBe(
      'Work is out, as its agent reported.'
    )
    expect(limitSentence('Work', null, { scope: 'unknown' }, now)).toBe(
      'Work is out, as its agent reported.'
    )
  })
})
