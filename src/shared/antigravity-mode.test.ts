import { describe, expect, it } from 'vitest'
import {
  antigravityModeArgv,
  antigravityProfileFlags,
  resolveAntigravityMode,
  stricterMode
} from './antigravity-mode'

const none = antigravityProfileFlags([])
const ASK = ['--settings', '{"agentMode":""}']

describe('stricterMode', () => {
  it('orders plan, ask, accept edits, auto, and reads what it does not know as ask', () => {
    expect(stricterMode('auto', 'plan')).toBe('plan')
    expect(stricterMode('auto', 'accept-edits')).toBe('accept-edits')
    expect(stricterMode('accept-edits', 'default')).toBe('default')
    expect(stricterMode('auto', 'yolo')).toBe('default')
    expect(stricterMode(undefined, 'auto')).toBe('auto')
    expect(stricterMode()).toBeUndefined()
  })
})

describe('antigravityProfileFlags', () => {
  it.each([
    [['--mode', 'plan'], 'plan'],
    [['--mode=plan'], 'plan'],
    [['-mode', 'plan'], 'plan'],
    [['-mode=plan'], 'plan'],
    [['--mode', 'default'], 'default'],
    [['--mode', 'auto', '--mode', 'plan'], 'plan'],
    [['--mode', 'bogus'], 'bogus'],
    [['--mode=Plan'], 'Plan'],
    [['--mode'], '']
  ])('reads the mode of %j as the CLI does', (args, mode) => {
    expect(antigravityProfileFlags(args).mode).toBe(mode)
  })
  it('reads --settings in its four spellings and leaves the rest', () => {
    for (const args of [
      ['--settings', '{}'],
      ['--settings={}'],
      ['-settings', '{}'],
      ['-settings={}']
    ])
      expect(antigravityProfileFlags(args).settings).toBe('{}')
    expect(antigravityProfileFlags(['--model', 'x', '--sandbox'])).toEqual({
      rest: ['--model', 'x', '--sandbox']
    })
  })
})

describe('resolveAntigravityMode: never looser than what was said', () => {
  const resolve = (input: Partial<Parameters<typeof resolveAntigravityMode>[0]>): unknown =>
    resolveAntigravityMode({ profile: none, ...input })

  it('leaves the CLI its own default when nothing was said', () => {
    expect(resolve({})).toBeUndefined()
  })
  it.each(['plan', 'default', 'accept-edits', 'auto'])('keeps %s when it is named', (named) => {
    expect(resolve({ named, setting: 'auto' })).toBe(named)
  })
  it.each(['acceptEdits', 'dontAsk', 'manual', 'read-only', 'bypassPermissions', ''])(
    'reads the foreign mode %j as Ask, or as the stricter setting',
    (named) => {
      expect(resolve({ named })).toBe('default')
      expect(resolve({ named, setting: 'plan' })).toBe('plan')
      expect(resolve({ named, setting: 'auto' })).toBe('default')
    }
  )
  it("takes the profile's mode over the setting", () => {
    const profile = antigravityProfileFlags(['--mode', 'plan'])
    expect(resolve({ profile, setting: 'auto' })).toBe('plan')
  })
  it.each(['bogus', 'Plan', ''])("reads a profile's unreadable %j as Ask, or stricter", (mode) => {
    const profile = { mode, rest: [] }
    expect(resolve({ profile })).toBe('default')
    expect(resolve({ profile, setting: 'plan' })).toBe('plan')
  })
  it("starts where the profile's settings do, under a pick", () => {
    expect(resolve({ settingsStart: 'plan' })).toBe('plan')
    expect(resolve({ settingsStart: 'auto', setting: 'default' })).toBe('default')
    expect(resolve({ settingsStart: 'plan', named: 'auto' })).toBe('auto')
  })
  it("never loosens a profile's own Plan for a word it does not know", () => {
    expect(resolve({ settingsStart: 'plan', named: 'acceptEdits' })).toBe('plan')
    expect(resolve({ settingsStart: 'plan', profile: { mode: 'bogus', rest: [] } })).toBe('plan')
  })
  it('caps everything, a pick too, by rules that must hold', () => {
    expect(resolve({ cap: 'default', named: 'auto' })).toBe('default')
    expect(resolve({ cap: 'default', named: 'plan' })).toBe('plan')
    expect(resolve({ cap: 'default', cliDefault: 'plan' })).toBe('plan')
    expect(resolve({ cap: 'default', cliDefault: 'auto' })).toBe('default')
  })
  it('asks in a routine, which runs with nobody at the keyboard', () => {
    expect(resolve({ routine: true })).toBe('default')
    expect(resolve({ routine: true, setting: 'plan' })).toBe('plan')
    expect(resolve({ routine: true, named: 'auto' })).toBe('auto')
  })
})

describe('antigravityModeArgv', () => {
  it('never says `--mode default`, which agy refuses and runs in Auto', () => {
    expect(antigravityModeArgv([], 'default')).toEqual(ASK)
    expect(antigravityModeArgv(['--mode', 'default'])).toEqual(ASK)
    expect(antigravityModeArgv(['--mode', 'bogus'])).toEqual(ASK)
  })
  it.each(['plan', 'accept-edits', 'auto'])('passes %s as --mode', (mode) => {
    expect(antigravityModeArgv([], mode)).toEqual(['--mode', mode])
  })
  it('runs what was resolved, as the chat does, over the profile’s', () => {
    expect(antigravityModeArgv(['--mode', 'auto'], 'plan')).toEqual(['--mode', 'plan'])
    expect(antigravityModeArgv(['--mode', 'plan'], 'auto')).toEqual(['--mode', 'auto'])
    expect(antigravityModeArgv(['-mode=auto'], 'default')).toEqual(ASK)
  })
  it('keeps the profile’s inline settings beside Ask, its rules included', () => {
    expect(
      antigravityModeArgv(
        ['--settings', '{"permissions":{"deny":["command(rm)"]},"agentMode":"auto"}'],
        'default'
      )
    ).toEqual(['--settings', '{"permissions":{"deny":["command(rm)"]},"agentMode":""}'])
  })
  it('passes Ask through a settings file’s own copy, never dropping its rules', () => {
    expect(
      antigravityModeArgv(['--settings', 'rules.json'], 'default', '/private/ask.json')
    ).toEqual(['--settings', '/private/ask.json'])
  })
  it('never throws: with no copy it keeps the file and asks more', () => {
    expect(antigravityModeArgv(['--settings', 'rules.json'], 'default')).toEqual([
      '--settings',
      'rules.json',
      '--mode',
      'plan'
    ])
    expect(antigravityModeArgv(['--settings', '{"broken'], 'default')).toEqual([
      '--settings',
      '{"broken',
      '--mode',
      'plan'
    ])
  })
  it('touches nothing when nothing was said', () => {
    expect(antigravityModeArgv(['--sandbox'])).toEqual(['--sandbox'])
  })
})
