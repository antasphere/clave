import { describe, expect, it } from 'vitest'
import { resumeLaunch, runtimeChoices, launchModeFields } from './runtime-choices'

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

// PRDCT-4236: the dialog's reopen and the agent's resume default to the same
// remembered launch; the two copies had drifted on Codex's bypass.
describe('resumeLaunch: one rule for every reopen from the History', () => {
  const launch = { dangerous: true, permissionMode: 'plan', effort: 'high', accountId: 'a1' }

  it('Claude takes bypass, the mode, the effort and the account', () => {
    expect(resumeLaunch('claude', launch)).toEqual({
      dangerousMode: false,
      permissionMode: 'plan',
      allowDangerous: true,
      effort: 'high',
      accountId: 'a1'
    })
  })

  it('Codex takes bypass, the effort and the account, never a mode; Pi takes nothing', () => {
    expect(resumeLaunch('codex', { dangerous: true, effort: 'high', accountId: 'a1' })).toEqual({
      dangerousMode: true,
      effort: 'high',
      accountId: 'a1'
    })
    expect(resumeLaunch('codex', launch)).toEqual({
      dangerousMode: false,
      effort: 'high',
      accountId: 'a1'
    })
    expect(resumeLaunch('pi', launch)).toEqual({ dangerousMode: false })
  })

  it('the caller’s dangerous or permissionMode wins, and no remembered mode is filled', () => {
    expect(resumeLaunch('claude', launch, { dangerous: true })).toEqual({
      dangerousMode: true,
      effort: 'high',
      accountId: 'a1'
    })
    expect(resumeLaunch('claude', launch, { permissionMode: 'acceptEdits' })).toEqual({
      dangerousMode: false,
      effort: 'high',
      accountId: 'a1'
    })
  })
})

describe('launchModeFields: the mode and the effort an open names', () => {
  it('passes a mode to a Claude agent short of bypass only, and the effort to Claude and Codex', () => {
    const claude = { claudeMode: true, codexMode: false, dangerousMode: false }
    expect(
      launchModeFields({ ...claude, permissionMode: 'plan', effort: 'high', allowDangerous: true })
    ).toEqual({ permissionMode: 'plan', allowDangerous: true, effort: 'high' })
    expect(
      launchModeFields({
        ...claude,
        dangerousMode: true,
        permissionMode: 'plan',
        effort: 'high',
        allowDangerous: false
      })
    ).toEqual({ effort: 'high' })
    // Codex takes the effort and never a mode (round 9, Z3b).
    expect(
      launchModeFields({
        claudeMode: false,
        codexMode: true,
        dangerousMode: false,
        permissionMode: 'plan',
        effort: 'medium',
        allowDangerous: false
      })
    ).toEqual({ effort: 'medium' })
    expect(
      launchModeFields({
        claudeMode: false,
        codexMode: false,
        dangerousMode: false,
        permissionMode: 'plan',
        effort: 'high',
        allowDangerous: false
      })
    ).toEqual({})
    // Malformed values are dropped.
    expect(
      launchModeFields({
        ...claude,
        permissionMode: 'yolo',
        effort: 'HIGH; rm',
        allowDangerous: false
      })
    ).toEqual({})
  })
})
