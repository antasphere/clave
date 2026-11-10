import { describe, expect, it } from 'vitest'
import { reportFromWire, sameReport, sameScope, scopeFamily, scopeKey } from './limit-report'

/** The report's own small rules (PRDCT-4302): what the wire carries flat
 *  becomes the report the window stores, and the store keeps the report it
 *  has when a repeat says the same thing, and takes a new one when the scope
 *  or the return changed (round 1, E2 and T1). */
describe('the limit report', () => {
  it('names a family, or none', () => {
    expect(scopeFamily({ family: 'Fable' })).toBe('Fable')
    expect(scopeFamily('shared')).toBeNull()
    expect(scopeFamily('credits')).toBeNull()
    expect(scopeFamily('unknown')).toBeNull()
  })
  it('compares scopes by what they say', () => {
    expect(sameScope('shared', 'shared')).toBe(true)
    expect(sameScope('shared', 'credits')).toBe(false)
    expect(sameScope({ family: 'Fable' }, { family: 'Fable' })).toBe(true)
    expect(sameScope({ family: 'Fable' }, { family: 'Opus' })).toBe(false)
    expect(sameScope({ family: 'Fable' }, 'shared')).toBe(false)
    expect(scopeKey({ family: 'Fable' })).toBe('family:Fable')
    expect(scopeKey('credits')).toBe('credits')
  })
  it('keeps a report that says the same, takes one whose scope or return changed', () => {
    expect(sameReport(null, null)).toBe(true)
    expect(sameReport({ scope: 'shared' }, null)).toBe(false)
    expect(sameReport(null, { scope: 'shared' })).toBe(false)
    expect(sameReport({ scope: 'shared' }, { scope: 'shared' })).toBe(true)
    expect(sameReport({ scope: 'shared', resetsAt: 5 }, { scope: 'shared', resetsAt: 5 })).toBe(
      true
    )
    expect(sameReport({ scope: 'shared' }, { scope: { family: 'Fable' } })).toBe(false)
    expect(sameReport({ scope: 'shared', resetsAt: 5 }, { scope: 'shared', resetsAt: 6 })).toBe(
      false
    )
    expect(sameReport({ scope: 'shared', resetsAt: 5 }, { scope: 'shared' })).toBe(false)
  })
  it('reads the wire flat, the return kept when the wire had one and no key when it had none', () => {
    expect(reportFromWire({ scope: { family: 'Opus' }, resetsAt: 7 })).toEqual({
      scope: { family: 'Opus' },
      resetsAt: 7
    })
    expect(reportFromWire({ scope: 'credits' })).toEqual({ scope: 'credits' })
    expect('resetsAt' in reportFromWire({ scope: 'unknown' })).toBe(false)
  })
})
