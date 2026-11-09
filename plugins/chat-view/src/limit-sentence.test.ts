import { describe, expect, it } from 'vitest'
import { limitSentence } from './limit-sentence'

/** The ended notice's first sentence (PRDCT-4254): the account, the cap that
 *  is out and when it comes back; never "out of usage credits". */
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
    expect(limitSentence('Work', fable, now)).toBe('Work is out on Fable, back in 2d 5h.')
    expect(limitSentence('Work', { ...fable, resetsAt: null }, now)).toBe('Work is out on Fable.')
    expect(limitSentence('Work', { ...fable, kind: 'weekly_all', scope: null }, now)).toBe(
      'Work is out on Overall, back in 2d 5h.'
    )
  })
  it('names the account and the report when the poll shows no cap out', () => {
    expect(limitSentence('team@antasphere.com', null, now)).toBe(
      'team@antasphere.com is out, as its agent reported.'
    )
  })
})
