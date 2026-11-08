import { describe, expect, it } from 'vitest'
import { runtimeChoices } from './runtime-choices'

// PRDCT-4191: "Lane · Company AI keys" came back from a Resume in Manual on
// opus after it had run with permissions skipped on another model. The record
// holds what the provider last acknowledged; this table is the one rule that
// turns it into the spawn options a Resume (daemon) and a restart (shell) pass.
describe('runtimeChoices', () => {
  it('turns a reported bypass into the dangerous flag, with no mode named', () => {
    expect(runtimeChoices({ dangerousMode: false, permissionMode: 'bypassPermissions' })).toEqual({
      dangerousMode: true
    })
  })

  it('passes another known mode and turns the dangerous flag off', () => {
    // The person left bypass for it, so the launch's flag must not win; the
    // way back to bypass stays open, since the launch had it (round 3, C5).
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'])
      expect(runtimeChoices({ dangerousMode: true, permissionMode: mode })).toEqual({
        dangerousMode: false,
        permissionMode: mode,
        allowDangerous: true
      })
  })

  it('keeps the launch flag when no mode was reported, or one it does not know', () => {
    expect(runtimeChoices({ dangerousMode: true })).toEqual({ dangerousMode: true })
    expect(runtimeChoices({})).toEqual({ dangerousMode: false })
    expect(runtimeChoices({ dangerousMode: true, permissionMode: 'yolo' })).toEqual({
      dangerousMode: true
    })
    expect(runtimeChoices({ dangerousMode: false, permissionMode: 'yolo' })).toEqual({
      dangerousMode: false
    })
  })

  it('carries the model and a well-formed effort, and drops an effort that is not one', () => {
    expect(runtimeChoices({ model: 'sonnet', effort: 'high' })).toEqual({
      dangerousMode: false,
      model: 'sonnet',
      effort: 'high'
    })
    for (const effort of ['High', '1x', '', 'a'.repeat(33), 'max; rm -rf'])
      expect(runtimeChoices({ effort })).toEqual({ dangerousMode: false })
    expect(runtimeChoices({ effort: 'x_high-2' }).effort).toBe('x_high-2')
  })
})

describe('bypass kept reachable (round 3, C5)', () => {
  it('a chat launched skipping permissions and resumed in another mode keeps the way back', () => {
    expect(runtimeChoices({ dangerousMode: true, permissionMode: 'plan' })).toEqual({
      dangerousMode: false,
      permissionMode: 'plan',
      allowDangerous: true
    })
    // Launched asking: nothing to keep.
    expect(runtimeChoices({ dangerousMode: false, permissionMode: 'plan' })).toEqual({
      dangerousMode: false,
      permissionMode: 'plan'
    })
    // Still in bypass: the flag itself, nothing to allow.
    expect(runtimeChoices({ dangerousMode: true, permissionMode: 'bypassPermissions' })).toEqual({
      dangerousMode: true
    })
  })
})
