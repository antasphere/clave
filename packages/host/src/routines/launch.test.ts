import { describe, expect, it } from 'vitest'
import type { LaunchProfilePreferences } from '../../../shared/src/agent-launch'
import { type LaunchFacts, resolveLaunch } from './launch'

const prefs: LaunchProfilePreferences = {
  version: 1,
  customProfiles: [
    {
      id: 'work',
      name: 'Work',
      family: 'claude',
      command: ['claude'],
      additionalArgs: ['--add-dir', '/tmp'],
      builtIn: false
    },
    // The chat form the host lists beside a saved profile (one definition, two forms).
    {
      id: 'chat:claude:work',
      name: 'Work (chat)',
      family: 'claude',
      command: ['claude'],
      additionalArgs: ['--add-dir', '/tmp'],
      builtIn: false,
      sourceProfileId: 'work'
    }
  ],
  globalDefaults: {},
  workspaceOverrides: { ws: { claude: 'work' } }
}

const facts = (overrides: Partial<LaunchFacts> = {}): LaunchFacts => ({
  preferences: () => prefs,
  accounts: (provider) =>
    provider === 'claude'
      ? [
          { id: 'default', label: 'Default', usable: true },
          { id: 'acc-2', label: 'Antasphere', usable: true }
        ]
      : [{ id: 'default', label: 'Default', usable: true }],
  selectedAccountId: () => undefined,
  ...overrides
})

const routine = (
  launch: Record<string, unknown>
): { name: string; workspaceId: string; launch: Record<string, unknown> } => ({
  name: 'r',
  workspaceId: 'ws',
  launch
})

describe('resolveLaunch', () => {
  it('falls back to the workspace defaults: a Claude chat on the workspace profile, the pool account', () => {
    const r = resolveLaunch(routine({}), facts())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.agent).toBe('claude')
    expect(r.form).toBe('chat')
    // The workspace's default Claude profile is "Work"; its chat form is what the launcher opens.
    expect(r.spawn.launchProfileId).toBe('chat:claude:work')
    expect(r.spawn.claudeMode).toBe(true)
    expect(r.spawn.dangerousMode).toBe(false)
    expect(r.spawn.claudeProfileId).toBe('default')
    expect(r.account).toBe('Default')
    expect(r.model).toBeNull()
  })

  it('starts exactly as declared: model, effort, profile by name, account by label, permissions off', () => {
    const r = resolveLaunch(
      routine({
        model: 'claude-opus-5-5',
        effort: 'high',
        profile: 'work',
        account: 'antasphere',
        dangerousMode: true,
        permissionMode: 'plan'
      }),
      facts()
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spawn).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'high',
      launchProfileId: 'chat:claude:work',
      claudeProfileId: 'acc-2',
      claudeProfileLabel: 'Antasphere',
      dangerousMode: true
    })
    // The skip flag wins: no permission mode beside it.
    expect(r.spawn.permissionMode).toBeUndefined()
    expect(r.model).toBe('claude-opus-5-5')
    expect(r.account).toBe('Antasphere')
  })

  it('a terminal form keeps the profile itself, and a permission mode without the skip flag', () => {
    const r = resolveLaunch(
      routine({ form: 'terminal', profile: 'Work', permissionMode: 'acceptEdits' }),
      facts()
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.form).toBe('terminal')
    expect(r.spawn.launchProfileId).toBe('work')
    expect(r.spawn.permissionMode).toBe('acceptEdits')
  })

  it('resolves Codex, Pi and Antigravity as the open-session tool does', () => {
    const codex = resolveLaunch(
      routine({ agent: 'codex', dangerousMode: true, model: 'gpt-5' }),
      facts()
    )
    expect(codex.ok && codex.spawn).toMatchObject({
      codexMode: true,
      dangerousMode: true,
      model: 'gpt-5',
      launchProfileId: 'codex-chat',
      codexAccountId: 'default'
    })
    const pi = resolveLaunch(
      routine({ agent: 'pi', thinking: 'high', provider: 'anthropic' }),
      facts()
    )
    expect(pi.ok && pi).toMatchObject({
      form: 'terminal',
      spawn: { piMode: true, piThinking: 'high', piProvider: 'anthropic' }
    })
    const agy = resolveLaunch(routine({ agent: 'antigravity' }), facts())
    expect(agy.ok && agy).toMatchObject({ form: 'terminal', spawn: { antigravityMode: true } })
  })

  it('fails the run on an invalid value, naming it, never a silent fallback', () => {
    const reasons = [
      resolveLaunch(routine({ agent: 'gemini' }), facts()),
      resolveLaunch(routine({ form: 'window' }), facts()),
      resolveLaunch(routine({ agent: 'pi', form: 'chat' }), facts()),
      resolveLaunch(routine({ agent: 'pi', dangerousMode: true }), facts()),
      resolveLaunch(routine({ agent: 'codex', permissionMode: 'plan' }), facts()),
      resolveLaunch(routine({ effort: 'Very High' }), facts()),
      resolveLaunch(routine({ agent: 'pi', thinking: 'ultra' }), facts()),
      resolveLaunch(routine({ agent: 'antigravity', model: 'x' }), facts()),
      resolveLaunch(routine({ profile: 'Nope' }), facts()),
      resolveLaunch(routine({ account: 'Nobody' }), facts()),
      resolveLaunch(routine({ agent: 'pi', account: 'any' }), facts())
    ]
    for (const r of reasons) expect(r.ok).toBe(false)
    expect(reasons.map((r) => (r.ok ? '' : r.reason))).toEqual([
      'agent "gemini" is not one of claude, codex, pi, antigravity',
      'form "window" is not chat or terminal',
      'form "chat" needs agent claude or codex; pi has no chat view',
      'dangerousMode is for claude and codex; pi has no such flag',
      'permissionMode is for claude; codex takes none',
      'effort "Very High" is not a level Claude knows',
      'thinking "ultra" is not one of off, minimal, low, medium, high, xhigh, max',
      'antigravity takes no model',
      'launch profile "Nope" is not a claude profile here ("Claude", "Work", "Work (chat)")',
      'Unknown Claude account "Nobody". Available: "Default" (default), "Antasphere" (acc-2)',
      'account is for claude and codex; pi has no account pool'
    ])
  })
})
