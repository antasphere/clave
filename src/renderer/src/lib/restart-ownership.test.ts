import { beforeEach, describe, expect, it } from 'vitest'
import {
  OWN_RESTART_TTL_MS,
  abandonOwnRestart,
  beginOwnRestart,
  ownAnswerApplies,
  resetOwnRestarts,
  servedRestartApplies
} from './restart-ownership'

/**
 * The window's own restart reaches the store twice on the server road: as
 * the answer of its call and as the server's `session.restarted` push.
 * Exactly one of the two applies, whichever order they arrive in; a push for
 * a restart the window did not ask for always applies.
 */
describe('restart ownership', () => {
  beforeEach(() => resetOwnRestarts())

  it('applies a push for a restart the window did not ask for', () => {
    expect(servedRestartApplies('s1')).toBe(true)
    expect(servedRestartApplies('s1')).toBe(true)
  })

  it('applies an answer with no mark (a caller that did not mark)', () => {
    expect(ownAnswerApplies('s1')).toBe(true)
  })

  it('push first, then the answer: the push applies, the answer steps aside', () => {
    beginOwnRestart('s1', 1000)
    expect(servedRestartApplies('s1', 1100)).toBe(true)
    expect(ownAnswerApplies('s1', 1200)).toBe(false)
    // The mark is spent: a later restart of the same tab by an agent applies.
    expect(servedRestartApplies('s1', 1300)).toBe(true)
  })

  it('answer first, then the push: the answer applies, the push steps aside', () => {
    beginOwnRestart('s1', 1000)
    expect(ownAnswerApplies('s1', 1100)).toBe(true)
    expect(servedRestartApplies('s1', 1200)).toBe(false)
    expect(servedRestartApplies('s1', 1300)).toBe(true)
  })

  it('a mark nobody consumed expires: a push past the TTL applies', () => {
    beginOwnRestart('s1', 1000)
    expect(ownAnswerApplies('s1', 1100)).toBe(true)
    // IPC road: no push for the window's own restart ever came. An agent
    // restarts the tab later; its push must apply.
    expect(servedRestartApplies('s1', 1100 + OWN_RESTART_TTL_MS + 1)).toBe(true)
  })

  it('an unapplied mark within the TTL is still owned by the push', () => {
    beginOwnRestart('s1', 1000)
    expect(servedRestartApplies('s1', 1000 + OWN_RESTART_TTL_MS)).toBe(true)
    expect(ownAnswerApplies('s1', 1000 + OWN_RESTART_TTL_MS + 1)).toBe(false)
  })

  it('a call that failed abandons its mark: a late push applies', () => {
    beginOwnRestart('s1', 1000)
    abandonOwnRestart('s1')
    expect(servedRestartApplies('s1', 1100)).toBe(true)
  })

  it('a mark on one tab says nothing about another', () => {
    beginOwnRestart('s1', 1000)
    expect(servedRestartApplies('s2', 1100)).toBe(true)
    expect(ownAnswerApplies('s1', 1200)).toBe(true)
  })
})
