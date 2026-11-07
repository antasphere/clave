import { describe, expect, it } from 'vitest'
import { shareAGroup } from './group-reach'

describe('shareAGroup', () => {
  const groups = [
    { sessionIds: ['tab', 'mate'], terminals: [{ sessionId: 'dev' }, { sessionId: null }] },
    { sessionIds: ['far'], terminals: [{ sessionId: 'far-dev' }] }
  ]
  it('counts the tabs and the live terminals of one group as members', () => {
    expect(shareAGroup(groups, 'tab', 'mate')).toBe(true)
    expect(shareAGroup(groups, 'tab', 'dev')).toBe(true)
    expect(shareAGroup(groups, 'dev', 'tab')).toBe(true)
  })
  it('refuses members of different groups, and never matches a stopped terminal', () => {
    expect(shareAGroup(groups, 'tab', 'far')).toBe(false)
    expect(shareAGroup(groups, 'tab', 'far-dev')).toBe(false)
    expect(shareAGroup([{ sessionIds: [], terminals: [{ sessionId: null }] }], 'x', 'x')).toBe(
      false
    )
  })
})
