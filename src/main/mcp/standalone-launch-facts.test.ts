import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '@clave/contract/sessions'
import type {
  CatalogModelView,
  ModelsCatalogView
} from '@clave/contract/settings/models-catalog-view'
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
  describe('Pi and OpenCode on stored connections', () => {
    const catalogModel = (id: string, deprecated = false): CatalogModelView => ({
      id,
      name: `${id} name`,
      reasoning: true,
      toolCall: true,
      ...(deprecated ? { status: 'deprecated' as const } : {})
    })
    const VIEW: ModelsCatalogView = {
      fetchedAt: 1,
      stale: false,
      providers: [
        {
          id: 'mistral',
          name: 'Mistral',
          models: [catalogModel('devstral'), catalogModel('old', true)]
        },
        { id: 'deepseek', name: 'DeepSeek', models: [catalogModel('deepseek-chat')] }
      ]
    }
    const connections = [
      { id: 'c-mi', label: 'Mistral work', company: 'mistral' as const },
      { id: 'c-ol', label: 'Local', company: 'ollama' as const },
      { id: 'c-ds', label: 'DeepSeek', company: 'deepseek' as const }
    ]
    const asked: (readonly string[])[] = []
    const stubbed = (catalog: StandaloneLaunchDeps['catalog']): StandaloneLaunchDeps =>
      deps({ catalog, providerConnections: () => connections })
    const reads = async (ids: readonly string[]): Promise<ModelsCatalogView> => {
      asked.push(ids)
      return VIEW
    }
    const DEFAULT = { id: null, label: 'Default', family: 'Default' }

    it('lists Pi’s default, each connection’s catalogue models in order, then the pinned', async () => {
      asked.length = 0
      expect(await standaloneLaunchFacts(stubbed(reads)).models('pi')).toEqual([
        DEFAULT,
        { id: 'devstral', label: 'devstral name', family: 'Mistral' },
        { id: 'deepseek-chat', label: 'deepseek-chat name', family: 'DeepSeek' },
        { id: 'kimi-k2', label: 'kimi-k2', family: 'kimi-k2' },
        { id: 'glm-5', label: 'glm-5', family: 'glm-5' }
      ])
      // Only the catalogue ids of the connections' companies are read.
      expect(asked).toEqual([['mistral', 'deepseek']])
    })
    it('lists OpenCode’s default and the catalogue models, no pinned model', async () => {
      expect(await standaloneLaunchFacts(stubbed(reads)).models('opencode')).toEqual([
        DEFAULT,
        { id: 'devstral', label: 'devstral name', family: 'Mistral' },
        { id: 'deepseek-chat', label: 'deepseek-chat name', family: 'DeepSeek' }
      ])
    })
    it('answers the default and the pinned when the catalogue read fails or is empty', async () => {
      const failing = standaloneLaunchFacts(
        stubbed(async () => Promise.reject(new Error('offline')))
      )
      expect(await failing.models('pi')).toEqual([
        DEFAULT,
        { id: 'kimi-k2', label: 'kimi-k2', family: 'kimi-k2' },
        { id: 'glm-5', label: 'glm-5', family: 'glm-5' }
      ])
      expect(await failing.models('opencode')).toEqual([DEFAULT])
      const empty = standaloneLaunchFacts(
        stubbed(async () => ({ fetchedAt: null, stale: true, providers: [] }))
      )
      expect(await empty.models('opencode')).toEqual([DEFAULT])
    })
    it('carries the rows into the shared function’s input', async () => {
      const launch = standaloneLaunchFacts(stubbed(reads))
      const input = launchOptionsInput(launch, undefined, await modelsOfHarnesses(launch))
      expect(input.models('opencode')).toEqual([
        DEFAULT,
        { id: 'devstral', label: 'devstral name', family: 'Mistral' },
        { id: 'deepseek-chat', label: 'deepseek-chat name', family: 'DeepSeek' }
      ])
    })
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
