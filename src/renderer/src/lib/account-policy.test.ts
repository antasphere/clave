import { describe, it, expect } from 'vitest'
import { decideAccountAction, ladderKey, type DecideInput } from './account-policy-rule'

const base: DecideInput = {
  alive: true,
  accountPinned: false,
  modelPinned: false,
  restarting: false,
  atLimit: true,
  reported: false,
  working: false,
  mode: 'propose',
  onFamilyLimit: 'switch-model',
  scope: 'shared',
  nextModel: null,
  nextAccountId: 'play',
  nextAdapterId: null,
  proposedKey: null,
  dismissedKey: null
}
const fable: DecideInput = { ...base, scope: { family: 'Fable' }, nextModel: 'claude-opus-5-5' }
const account = { kind: 'account', accountId: 'play' } as const
const model = { kind: 'model', model: 'claude-opus-5-5' } as const
const provider = { kind: 'provider', adapterId: 'codex-chat' } as const

/**
 * When a tab moves and when it only asks, and which rung it takes (ADR 0002,
 * PRDCT-4302). A wrong "switch" here restarts an agent mid-turn or moves a
 * tab off a subscription it could still use; a wrong "none" leaves the user
 * to find out at the next turn.
 */
describe('decideAccountAction', () => {
  it('does nothing while the account has headroom, or the tab is dead or restarting', () => {
    expect(decideAccountAction({ ...base, atLimit: false })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...base, alive: false })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...base, restarting: true })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...fable, atLimit: false, mode: 'automatic' })).toEqual({
      kind: 'none'
    })
  })

  it('a shared cap offers the account rung alone, as before', () => {
    expect(decideAccountAction(base)).toEqual({ kind: 'propose', rungs: [account] })
    expect(decideAccountAction({ ...base, mode: 'automatic' })).toEqual({
      kind: 'switch-account',
      accountId: 'play'
    })
    // A model rung target is ignored on a shared cap: the whole account is out.
    expect(decideAccountAction({ ...base, nextModel: 'claude-opus-5-5' })).toEqual({
      kind: 'propose',
      rungs: [account]
    })
  })

  it("the org's credits offer the account rung alone", () => {
    expect(
      decideAccountAction({ ...base, scope: 'credits', nextModel: 'claude-opus-5-5' })
    ).toEqual({ kind: 'propose', rungs: [account] })
    expect(
      decideAccountAction({ ...base, scope: 'credits', mode: 'automatic', reported: true })
    ).toEqual({ kind: 'switch-account', accountId: 'play' })
  })

  it("a family's cap offers the model rung first, then the account", () => {
    expect(decideAccountAction(fable)).toEqual({ kind: 'propose', rungs: [model, account] })
    // With nowhere else to go the model rung stands alone.
    expect(decideAccountAction({ ...fable, nextAccountId: null })).toEqual({
      kind: 'propose',
      rungs: [model]
    })
    // No open model of another family: the account rung alone.
    expect(decideAccountAction({ ...fable, nextModel: null })).toEqual({
      kind: 'propose',
      rungs: [account]
    })
  })

  it("in automatic mode a family's cap follows the setting, and falls to the other rung", () => {
    expect(decideAccountAction({ ...fable, mode: 'automatic' })).toEqual({
      kind: 'switch-model',
      model: 'claude-opus-5-5'
    })
    expect(
      decideAccountAction({ ...fable, mode: 'automatic', onFamilyLimit: 'switch-account' })
    ).toEqual({ kind: 'switch-account', accountId: 'play' })
    // The preferred rung is not there: the other one is taken.
    expect(decideAccountAction({ ...fable, mode: 'automatic', nextModel: null })).toEqual({
      kind: 'switch-account',
      accountId: 'play'
    })
    expect(
      decideAccountAction({
        ...fable,
        mode: 'automatic',
        onFamilyLimit: 'switch-account',
        nextAccountId: null
      })
    ).toEqual({ kind: 'switch-model', model: 'claude-opus-5-5' })
  })

  it('a pin drops its rung: the account pin the account, the model pin the model, both mean no move', () => {
    expect(decideAccountAction({ ...base, accountPinned: true })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...base, mode: 'automatic', accountPinned: true })).toEqual({
      kind: 'none'
    })
    expect(decideAccountAction({ ...fable, accountPinned: true })).toEqual({
      kind: 'propose',
      rungs: [model]
    })
    expect(decideAccountAction({ ...fable, modelPinned: true })).toEqual({
      kind: 'propose',
      rungs: [account]
    })
    // Pinned to its model in automatic mode: the setting says model, the pin says no.
    expect(decideAccountAction({ ...fable, modelPinned: true, mode: 'automatic' })).toEqual({
      kind: 'switch-account',
      accountId: 'play'
    })
    expect(decideAccountAction({ ...fable, modelPinned: true, accountPinned: true })).toEqual({
      kind: 'none'
    })
    // The model pin changes nothing on a shared cap.
    expect(decideAccountAction({ ...base, modelPinned: true })).toEqual({
      kind: 'propose',
      rungs: [account]
    })
  })

  it("brings back a tab that ended on the CLI's own report, on the account rung only", () => {
    // The CLI reported the limit and ended: moved (automatic) or proposed.
    expect(decideAccountAction({ ...base, alive: false, reported: true })).toEqual({
      kind: 'propose',
      rungs: [account]
    })
    expect(
      decideAccountAction({ ...base, alive: false, reported: true, mode: 'automatic' })
    ).toEqual({ kind: 'switch-account', accountId: 'play' })
    // A dead process takes no set_model: a family report on a dead tab
    // offers the account.
    expect(decideAccountAction({ ...fable, alive: false, reported: true })).toEqual({
      kind: 'propose',
      rungs: [account]
    })
    expect(
      decideAccountAction({ ...fable, alive: false, reported: true, mode: 'automatic' })
    ).toEqual({ kind: 'switch-account', accountId: 'play' })
    // The poll alone says the account is out: a dead tab stays dead.
    expect(decideAccountAction({ ...base, alive: false, reported: false })).toEqual({
      kind: 'none'
    })
    // A pin or nowhere to go still holds.
    expect(
      decideAccountAction({ ...base, alive: false, reported: true, accountPinned: true })
    ).toEqual({ kind: 'none' })
    expect(
      decideAccountAction({ ...base, alive: false, reported: true, nextAccountId: null })
    ).toEqual({ kind: 'none' })
  })

  it('does nothing when no rung is open', () => {
    expect(decideAccountAction({ ...base, nextAccountId: null })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...base, mode: 'automatic', nextAccountId: null })).toEqual({
      kind: 'none'
    })
    expect(decideAccountAction({ ...fable, nextModel: null, nextAccountId: null })).toEqual({
      kind: 'none'
    })
  })

  it('the provider rung comes last, and is only ever offered', () => {
    expect(decideAccountAction({ ...fable, nextAdapterId: 'codex-chat' })).toEqual({
      kind: 'propose',
      rungs: [model, account, provider]
    })
    expect(decideAccountAction({ ...base, nextAdapterId: 'codex-chat' })).toEqual({
      kind: 'propose',
      rungs: [account, provider]
    })
    // Nowhere else on this provider: the provider rung stands alone, proposed
    // even in automatic mode.
    expect(
      decideAccountAction({ ...base, nextAccountId: null, nextAdapterId: 'codex-chat' })
    ).toEqual({ kind: 'propose', rungs: [provider] })
    expect(
      decideAccountAction({
        ...base,
        mode: 'automatic',
        nextAccountId: null,
        nextAdapterId: 'codex-chat'
      })
    ).toEqual({ kind: 'propose', rungs: [provider] })
    // In automatic mode the provider rung never pre-empts the others.
    expect(
      decideAccountAction({ ...fable, mode: 'automatic', nextAdapterId: 'codex-chat' })
    ).toEqual({ kind: 'switch-model', model: 'claude-opus-5-5' })
  })

  it('proposes once per ladder, and not again after a dismissal of it', () => {
    const key = ladderKey([model, account])
    expect(decideAccountAction({ ...fable, proposedKey: key })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...fable, dismissedKey: key })).toEqual({ kind: 'none' })
    // The ladder changed (the pool moved on to another account, the model
    // rung closed): the new ladder is proposed.
    expect(decideAccountAction({ ...fable, dismissedKey: key, nextAccountId: 'team' })).toEqual({
      kind: 'propose',
      rungs: [model, { kind: 'account', accountId: 'team' }]
    })
    expect(decideAccountAction({ ...fable, dismissedKey: key, nextModel: null })).toEqual({
      kind: 'propose',
      rungs: [account]
    })
    // A dismissal of the account alone does not cover the ladder with the model.
    expect(decideAccountAction({ ...fable, dismissedKey: ladderKey([account]) })).toEqual({
      kind: 'propose',
      rungs: [model, account]
    })
  })

  it('switches automatically only once the agent is idle; a working tab gets the proposal', () => {
    expect(decideAccountAction({ ...base, mode: 'automatic', working: true })).toEqual({
      kind: 'propose',
      rungs: [account]
    })
    expect(decideAccountAction({ ...fable, mode: 'automatic', working: true })).toEqual({
      kind: 'propose',
      rungs: [model, account]
    })
    expect(decideAccountAction({ ...base, mode: 'propose', working: true })).toEqual({
      kind: 'propose',
      rungs: [account]
    })
  })
})
