import { describe, expect, it } from 'vitest'
import type { WorkHolding } from '@clave/contract/work-rules'
import type { WorkEntry } from './work-presentation'
import { unresolvedWords, vacantWords } from './work-words'

/** An entry as the sidebar draws it, its owner as given. */
const entry = (kind: 'lane' | 'wave', owner: WorkHolding): WorkEntry => ({
  unit: kind === 'wave' ? 'wave-1' : 'lane-a',
  kind,
  label: kind === 'wave' ? 'Mobile beta' : 'Pair the phone',
  ownerRole: kind === 'wave' ? 'coordinator' : 'lead',
  owner,
  reviewer: { state: 'vacant' },
  workers: [],
  pending: [],
  history: [],
  members: ['a', 'b'],
  anchor: 'a',
  target: owner.state === 'held' || owner.state === 'completed' ? owner.id : null,
  agents: []
})

describe('vacantWords', () => {
  it('says a lane has no lead in this window, and why that may be', () => {
    expect(vacantWords(entry('lane', { state: 'vacant' }))).toBe(
      'No lead in this window: it may be open in another window, or this lane has none yet'
    )
  })

  it('says a wave has no coordinator in this window', () => {
    expect(vacantWords(entry('wave', { state: 'vacant' }))).toBe(
      'No coordinator in this window: it may be open in another window, or this wave has none yet'
    )
  })

  it('says nothing for a unit somebody holds, completed or unresolved', () => {
    expect(vacantWords(entry('lane', { state: 'held', id: 'a' }))).toBeNull()
    expect(vacantWords(entry('lane', { state: 'completed', id: 'a' }))).toBeNull()
    expect(
      vacantWords(entry('lane', { state: 'unresolved', reason: 'not-accepted', candidates: ['b'] }))
    ).toBeNull()
  })
})

describe('unresolvedWords', () => {
  it('names what disagrees, for each reason', () => {
    expect(
      unresolvedWords(
        entry('lane', { state: 'unresolved', reason: 'several', candidates: ['a', 'b'] })
      )
    ).toBe("Unresolved: 2 sessions say they are this lane's lead")
    expect(
      unresolvedWords(
        entry('wave', { state: 'unresolved', reason: 'not-accepted', candidates: ['b'] })
      )
    ).toBe('Unresolved: a handover to a new coordinator was never accepted')
    expect(
      unresolvedWords(
        entry('lane', { state: 'unresolved', reason: 'no-current', candidates: ['a'] })
      )
    ).toBe('Unresolved: this lane has no current lead')
  })

  it('says nothing for a unit that is not unresolved', () => {
    expect(unresolvedWords(entry('lane', { state: 'vacant' }))).toBeNull()
    expect(unresolvedWords(entry('wave', { state: 'held', id: 'a' }))).toBeNull()
  })
})
