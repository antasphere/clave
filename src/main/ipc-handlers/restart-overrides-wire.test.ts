import { describe, expect, it } from 'vitest'
import { continuedFromOf, restartOverridesFromWire } from './restart-overrides-wire'

describe('the IPC road of a restart reads the provider switch in its own shape (PRDCT-4300)', () => {
  it('takes every field of a provider switch, the account and the flags', () => {
    expect(
      restartOverridesFromWire({
        codexAccountId: 'c1',
        codexAccountLabel: 'Codex 1',
        resendRejected: true,
        onlyIfStopped: false,
        adapterId: 'codex-chat',
        model: 'gpt-5.5',
        resume: 'thread-7',
        firstMessage: 'hand',
        continuedFrom: { provider: 'claude', road: 'converted' }
      })
    ).toEqual({
      claudeProfileId: undefined,
      claudeProfileLabel: undefined,
      codexAccountId: 'c1',
      codexAccountLabel: 'Codex 1',
      resendRejected: true,
      onlyIfStopped: false,
      adapterId: 'codex-chat',
      model: 'gpt-5.5',
      resume: 'thread-7',
      firstMessage: 'hand',
      continuedFrom: { provider: 'claude', road: 'converted' }
    })
  })
  it('leaves out a field of the wrong shape rather than throwing, the note included', () => {
    const out = restartOverridesFromWire({
      adapterId: 7,
      model: ['x'],
      continuedFrom: { provider: 'claude', road: 'teleported' },
      resendRejected: 'yes'
    })
    expect(out.adapterId).toBeUndefined()
    expect(out.model).toBeUndefined()
    expect(out.continuedFrom).toBeUndefined()
    expect(out.resendRejected).toBe(false)
    expect(restartOverridesFromWire(undefined).onlyIfStopped).toBe(false)
    expect(continuedFromOf({ provider: 'codex', road: 'handoff' })).toEqual({
      provider: 'codex',
      road: 'handoff'
    })
    expect(continuedFromOf('claude')).toBeUndefined()
  })
})
