import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '@clave/contract/sessions'
import type { AgentUpdateStatus } from '../../shared/agent-updates'
import type { LaunchProfilePreferences } from '../../shared/agent-launch'
import { usageSummaryOf } from '../../shared/usage-summary'
import type { LaunchFacts } from '../routines/launch'
import {
  accountOf,
  launchOptionsInput,
  modelsOfHarnesses,
  standaloneLaunchFacts,
  type StandaloneLaunchDeps
} from './standalone-launch-facts'

const fableOut = usageSummaryOf({
  windows: [
    { kind: 'weekly_all', scope: null, usedPercentage: 30, severity: null, resetsAt: null },
    {
      kind: 'weekly_scoped',
      scope: 'Fable',
      usedPercentage: 100,
      severity: 'critical',
      resetsAt: null
    }
  ]
})

const prefs: LaunchProfilePreferences = {
  version: 1,
  customProfiles: [
    {
      id: 'pi-kimi',
      name: 'Pi on Kimi',
      family: 'pi',
      command: ['pi'],
      additionalArgs: [],
      pi: { model: 'kimi-k2' }
    },
    {
      id: 'pi-kimi-2',
      name: 'Pi again',
      family: 'pi',
      command: ['pi'],
      additionalArgs: [],
      pi: { model: 'kimi-k2' }
    },
    {
      id: 'pi-glm',
      name: 'Pi on GLM',
      family: 'pi',
      command: ['pi'],
      additionalArgs: [],
      pi: { model: 'glm-5' }
    }
  ],
  globalDefaults: {},
  workspaceOverrides: {}
}

const facts: LaunchFacts = {
  preferences: () => prefs,
  accounts: (provider) =>
    provider === 'claude'
      ? [{ id: 'default', label: 'Romain', usable: true, ...(fableOut ? { usage: fableOut } : {}) }]
      : [{ id: 'key', label: 'API key', usable: true, fallback: true }],
  selectedAccountId: () => undefined
}

const deps = (over: Partial<StandaloneLaunchDeps> = {}): StandaloneLaunchDeps => ({
  facts,
  detection: { detect: async () => [] },
  identity: () => ({ id: 'srv', name: 'box' }),
  preferences: () => undefined,
  codexModels: async () => [{ id: 'gpt-6', label: 'GPT-6' }],
  homeDir: '/home/me',
  defaultProfile: (family) => ({ id: `builtin-${family}` }),
  now: () => 1,
  ...over
})

const record = (over: Partial<SessionRecord>): SessionRecord =>
  ({ id: 's1', cwd: '/tmp', ...over }) as SessionRecord

describe('accountOf', () => {
  it('names a Claude tab’s connection and judges it on the tab’s own model', () => {
    expect(accountOf(facts, record({ claudeMode: true, model: 'claude-fable-5-1[1m]' }))).toEqual({
      id: 'default',
      label: 'Romain',
      exhausted: true
    })
    expect(accountOf(facts, record({ claudeMode: true, model: 'claude-opus-5-5' }))).toEqual({
      id: 'default',
      label: 'Romain',
      exhausted: false
    })
  })
  it('names a Codex tab’s connection, a removed one by the record’s label or the fallback word', () => {
    expect(accountOf(facts, record({ codexMode: true, codexAccountId: 'key' }))).toEqual({
      id: 'key',
      label: 'API key',
      exhausted: false
    })
    expect(
      accountOf(
        facts,
        record({ codexMode: true, codexAccountId: 'gone', codexAccountLabel: 'Old' })
      )
    ).toMatchObject({ id: 'gone', label: 'Old' })
    expect(accountOf(facts, record({ claudeMode: true, claudeProfileId: 'gone' }))).toMatchObject({
      id: 'gone',
      label: 'Removed account'
    })
  })
  it('answers null for a tab on a harness with no pool', () => {
    expect(accountOf(facts, record({ piMode: true }))).toBeNull()
  })
})

describe('standaloneLaunchFacts', () => {
  it('answers Codex’s models as the launcher maps them, unavailable on a rejection or an empty list', async () => {
    expect(await standaloneLaunchFacts(deps()).models('codex')).toEqual([
      { id: 'gpt-6', label: 'GPT-6', family: 'GPT-6' }
    ])
    const failing = standaloneLaunchFacts(
      deps({ codexModels: async () => Promise.reject(new Error('no app-server')) })
    )
    expect(await failing.models('codex')).toBe('unavailable')
    expect(await standaloneLaunchFacts(deps({ codexModels: async () => [] })).models('codex')).toBe(
      'unavailable'
    )
  })
  it('answers Pi’s Default and the distinct models its profiles pin', async () => {
    expect(await standaloneLaunchFacts(deps()).models('pi')).toEqual([
      { id: null, label: 'Default', family: 'Default' },
      { id: 'kimi-k2', label: 'kimi-k2', family: 'kimi-k2' },
      { id: 'glm-5', label: 'glm-5', family: 'glm-5' }
    ])
  })
  it('reads the launch settings and the switch mode from the preferences, with their defaults', () => {
    const read = standaloneLaunchFacts(
      deps({
        preferences: (key) =>
          ({
            interactionMode: 'terminal',
            harnessSettings: { claude: { preferredModel: 'claude-opus-5-5' } },
            accountSwitchMode: 'automatic'
          })[key]
      })
    )
    expect(read.interactionMode()).toBe('terminal')
    expect(read.harnessSettings()).toEqual({ claude: { preferredModel: 'claude-opus-5-5' } })
    expect(read.switchMode()).toBe('automatic')
    const none = standaloneLaunchFacts(deps())
    expect(none.interactionMode()).toBe('chat')
    expect(none.switchMode()).toBe('propose')
  })
  it('answers no default profile when the resolution throws', () => {
    const throwing = standaloneLaunchFacts(
      deps({
        defaultProfile: () => {
          throw new Error('gone')
        }
      })
    )
    expect(throwing.defaultProfileId('claude')).toBeUndefined()
  })
})

describe('launchOptionsInput', () => {
  it('maps detection’s statuses to presence, and none when there are no statuses', async () => {
    const launch = standaloneLaunchFacts(deps())
    const statuses = [
      { id: 'codex', installed: true, currentVersion: '0.80.0', lastCheckedAt: 5 },
      { id: 'pi', installed: false, currentVersion: null, lastCheckedAt: 6 }
    ] as AgentUpdateStatus[]
    const input = launchOptionsInput(launch, statuses, await modelsOfHarnesses(launch))
    expect(input.presence('codex')).toEqual({ installed: true, version: '0.80.0', checkedAt: 5 })
    expect(input.presence('pi')).toEqual({ installed: false, version: null, checkedAt: 6 })
    expect(input.presence('claude')).toBeUndefined()
    expect(launchOptionsInput(launch, undefined, {}).presence('codex')).toBeUndefined()
    expect(input.machine).toEqual({ id: 'srv', name: 'box' })
    expect(input.profiles('pi').map((p) => p.id)).toEqual([
      'builtin-pi',
      'pi-kimi',
      'pi-kimi-2',
      'pi-glm'
    ])
    expect(input.defaultProfileId('codex')).toBe('builtin-codex')
    expect(input.connections('codex')).toEqual([
      { id: 'key', label: 'API key', usable: true, fallback: true }
    ])
  })
})
