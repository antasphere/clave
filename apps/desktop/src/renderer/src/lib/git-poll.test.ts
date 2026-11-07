import { describe, it, expect } from 'vitest'
import { mergeStatuses } from './git-poll'

/** A watcher-driven read of a few repos folded into the panel's list (PRDCT-3775). */
describe('mergeStatuses', () => {
  const reading = {
    mode: 'multi' as const,
    truncated: false,
    live: true,
    repos: [
      { name: 'a', path: '/a', status: { branch: 'main' } },
      { name: 'b', path: '/b', status: { branch: 'dev' } }
    ]
  }

  it('replaces the repos it names and keeps the others as they were', () => {
    const next = mergeStatuses(reading, [{ path: '/b', status: { branch: 'lane' } }])
    expect(next.repos.map((r) => r.status.branch)).toEqual(['main', 'lane'])
    expect(next.repos[0]).toBe(reading.repos[0])
  })

  it('gives back the same reading when it names no listed repo', () => {
    expect(mergeStatuses(reading, [{ path: '/gone', status: { branch: 'x' } }])).toBe(reading)
    expect(mergeStatuses(reading, [])).toBe(reading)
  })

  it('leaves a non-multi reading alone', () => {
    const single = { mode: 'single' as const }
    expect(mergeStatuses(single, [{ path: '/a', status: { branch: 'x' } }])).toBe(single)
  })
})
