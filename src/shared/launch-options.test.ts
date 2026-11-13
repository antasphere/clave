import { describe, it, expect } from 'vitest'
import {
  launchOptions,
  suggestedConnection,
  poolsOf,
  type HarnessOptions,
  type HarnessPresence,
  type LaunchOptions,
  type LaunchModel,
  type LaunchOptionsInput,
  type PooledConnection
} from './launch-options'
import { HARNESSES, HARNESS_BY_ID, type HarnessId } from './harness'
import { BUILT_IN_LAUNCH_PROFILES, type LaunchProfile } from './agent-launch'
import { CLAUDE_MODELS } from './claude-models'
import { usageSummaryOf } from './usage-summary'
import type { PoolUsageWindow } from './account-pool'

/**
 * What an agent reads of the launcher (`clave_launch_options`). Silent when
 * wrong: a model offered that no connection can pay for, a suggested
 * connection the launch would not take, a harness listed that is not there.
 */
const w = (over: Partial<PoolUsageWindow> & { kind: string }): PoolUsageWindow => ({
  scope: null,
  usedPercentage: 0,
  severity: null,
  resetsAt: null,
  ...over
})

const DAY = 86_400_000
const H = 3_600_000
const now = Date.UTC(2026, 10, 13, 12, 0, 0)
const FABLE = 'claude-fable-5-1[1m]'
const OPUS = 'claude-opus-5-5'

/** Romain's own: the week at 40%, the Fable week spent. */
const fableOut: PooledConnection = {
  id: 'default',
  label: 'Romain',
  usable: true,
  usage: usageSummaryOf({
    windows: [
      w({ kind: 'session', usedPercentage: 20, resetsAt: now + 2 * H }),
      w({ kind: 'weekly_all', usedPercentage: 40, resetsAt: now + 2 * DAY + 5 * H }),
      w({
        kind: 'weekly_scoped',
        scope: 'Fable',
        usedPercentage: 100,
        severity: 'critical',
        resetsAt: now + 3 * DAY
      })
    ]
  })
}
/** A second subscription, open on every family. */
const open = (fableUsed = 30): PooledConnection => ({
  id: 'work',
  label: 'Work',
  usable: true,
  usage: usageSummaryOf({
    windows: [
      w({ kind: 'weekly_all', usedPercentage: 10, resetsAt: now + 4 * DAY }),
      w({
        kind: 'weekly_scoped',
        scope: 'Fable',
        usedPercentage: fableUsed,
        severity: fableUsed >= 100 ? 'critical' : null,
        resetsAt: now + 4 * DAY
      })
    ]
  })
})
const codexKey: PooledConnection = { id: 'key', label: 'API key', usable: true, fallback: true }

const piCustom: LaunchProfile = {
  id: 'pi-kimi',
  name: 'Pi on Kimi',
  family: 'pi',
  command: ['pi'],
  additionalArgs: [],
  pi: { model: 'kimi-k2' }
}
const claudeCustom: LaunchProfile = {
  id: 'claude-yolo',
  name: 'Claude yolo',
  family: 'claude',
  command: ['claude'],
  additionalArgs: ['--verbose']
}
const claudeChat: LaunchProfile = {
  id: 'claude-chat',
  name: 'Claude (chat)',
  family: 'claude',
  command: ['claude'],
  additionalArgs: [],
  builtIn: true
}
const claudeCustomChat: LaunchProfile = {
  ...claudeCustom,
  id: 'chat:claude:claude-yolo',
  name: 'Claude yolo (chat)',
  sourceProfileId: 'claude-yolo'
}

const PROFILES: LaunchProfile[] = [
  ...BUILT_IN_LAUNCH_PROFILES,
  claudeChat,
  claudeCustom,
  claudeCustomChat,
  piCustom
]

const PRESENCE: Partial<Record<HarnessId, HarnessPresence>> = {
  codex: { installed: true, version: '0.80.0', checkedAt: now - H },
  antigravity: { installed: false, version: null, checkedAt: now - H },
  pi: { installed: false, version: null, checkedAt: now - H },
  opencode: { installed: true, version: '2.0.1', checkedAt: now - H }
}

const claudeModels: LaunchModel[] = CLAUDE_MODELS.map((m) => ({
  id: m.id,
  label: m.name,
  family: m.alias.charAt(0).toUpperCase() + m.alias.slice(1)
}))

function input(over: Partial<LaunchOptionsInput> = {}): LaunchOptionsInput {
  return {
    machine: { id: 'local', name: 'This Mac' },
    harnesses: HARNESSES,
    presence: (id) => PRESENCE[id],
    profiles: (id) => PROFILES.filter((p) => p.family === id),
    defaultProfileId: (id) => (id === 'claude' ? 'claude-chat' : `builtin-${id}`),
    models: (id) => {
      if (id === 'claude') return claudeModels
      if (id === 'codex') return 'unavailable'
      if (id === 'pi') {
        return [
          { id: null, label: 'Default', family: 'Default' },
          { id: 'kimi-k2', label: 'kimi-k2', family: 'kimi-k2' }
        ]
      }
      return []
    },
    harnessSettings: { claude: { preferredModel: FABLE } },
    interactionMode: 'chat',
    connections: (pool) =>
      pool === 'claude' ? [fableOut, open()] : pool === 'codex' ? [codexKey] : [],
    selectedConnectionId: (pool) => (pool === 'claude' ? 'default' : undefined),
    preferRecommended: false,
    launchModel: () => undefined,
    now,
    ...over
  }
}

const harness = (options: LaunchOptions, id: HarnessId): HarnessOptions =>
  options.harnesses.find((h) => h.id === id)!

describe('which harnesses are listed', () => {
  it('lists every harness but the one a check found absent, in table order', () => {
    const options = launchOptions(input())
    expect(options.notInstalled).toEqual(['Antigravity'])
    expect(options.harnesses.map((h) => h.id)).toEqual(['claude', 'codex', 'pi', 'opencode'])
    expect(options.machine).toEqual({ id: 'local', name: 'This Mac' })
    expect(options.interactionMode).toBe('chat')
  })
  it('says unknown when this road never checks, and the version when it does', () => {
    const options = launchOptions(input())
    expect(harness(options, 'claude').installed).toBeNull()
    expect(harness(options, 'claude').version).toBeNull()
    expect(harness(options, 'opencode').installed).toBe(true)
    expect(harness(options, 'opencode').version).toBe('2.0.1')
  })
  it('lists a harness detection says is absent when the person saved a profile for it', () => {
    const pi = harness(launchOptions(input()), 'pi')
    expect(pi.installed).toBe(false)
    // Without the saved profile it goes to notInstalled.
    const bare = launchOptions(
      input({ profiles: (id) => PROFILES.filter((p) => p.family === id && p !== piCustom) })
    )
    expect(bare.notInstalled).toEqual(['Antigravity', 'Pi'])
  })
  it('lists a harness not checked yet', () => {
    const options = launchOptions(
      input({
        presence: (id) =>
          id === 'antigravity' ? { installed: false, version: null, checkedAt: null } : PRESENCE[id]
      })
    )
    expect(options.notInstalled).toEqual([])
  })
})

describe('the models and the default one', () => {
  it('takes the default model from the settings, else the remembered launch model', () => {
    expect(harness(launchOptions(input()), 'claude').defaultModel).toBe(FABLE)
    const asked: [string, string | undefined][] = []
    const remembered = launchOptions(
      input({
        harnessSettings: {},
        launchModel: (pool, profileId) => {
          asked.push([pool, profileId])
          return OPUS
        }
      })
    )
    expect(harness(remembered, 'claude').defaultModel).toBe(OPUS)
    expect(asked).toContainEqual(['claude', 'claude-chat'])
    expect(harness(launchOptions(input({ harnessSettings: {} })), 'claude').defaultModel).toBeNull()
  })
  it('serves Fable while one connection is open on it, and says why not when none is', () => {
    const claude = harness(launchOptions(input()), 'claude')
    const fableRow = claude.models.find((m) => m.id === FABLE)!
    expect(fableRow).toMatchObject({ served: true, reason: null, family: 'Fable' })
    const spent = launchOptions(
      input({ connections: (pool) => (pool === 'claude' ? [fableOut, open(100)] : []) })
    )
    const spentClaude = harness(spent, 'claude')
    expect(spentClaude.models.find((m) => m.id === FABLE)).toMatchObject({
      served: false,
      reason: 'No connection with Fable credits'
    })
    expect(spentClaude.models.find((m) => m.id === OPUS)).toMatchObject({
      served: true,
      reason: null
    })
  })
  it('offers Default and the pinned model on Pi, the Default row when the list could not be read', () => {
    const options = launchOptions(input())
    expect(harness(options, 'pi').models.map((m) => m.id)).toEqual([null, 'kimi-k2'])
    expect(harness(options, 'pi').models.every((m) => m.served)).toBe(true)
    expect(harness(options, 'pi').defaultModel).toBeNull()
    expect(harness(options, 'codex').models).toEqual([
      { id: null, label: 'Default', family: 'Default', served: true, reason: null }
    ])
  })
  it('offers no model to a harness that takes none', () => {
    const opencode = harness(launchOptions(input()), 'opencode')
    expect(opencode.takesModel).toBe(false)
    expect(opencode.models).toEqual([])
    expect(opencode.defaultModel).toBeNull()
    expect(opencode.chatView).toBe(false)
    expect(harness(launchOptions(input()), 'claude').chatView).toBe(true)
  })
})

describe('the connections that pay', () => {
  it('marks exactly the pick as suggested, judged on the default model', () => {
    const claude = harness(launchOptions(input()), 'claude')
    expect(claude.connections.map((c) => [c.id, c.suggested, c.exhausted])).toEqual([
      ['default', false, true],
      ['work', true, false]
    ])
    // On Opus the selected one keeps the launch, and is open.
    const onOpus = harness(
      launchOptions(input({ harnessSettings: { claude: { preferredModel: OPUS } } })),
      'claude'
    )
    expect(onOpus.connections.map((c) => [c.id, c.suggested, c.exhausted])).toEqual([
      ['default', true, false],
      ['work', false, false]
    ])
  })
  it('reads the headroom in the launcher words, and every cap of the account', () => {
    const claude = harness(launchOptions(input()), 'claude')
    const [romain, work] = claude.connections
    expect(romain.headroom).toBe('60% left · Overall · Fable out · back in 3d')
    expect(work.headroom).toBe('90% left · Overall')
    expect(romain.label).toBe('Romain')
    expect(romain.pool).toBe('claude')
    expect(romain.windows).toEqual([
      {
        name: '5h',
        kind: 'session',
        scope: null,
        leftPercent: 80,
        resetsAt: now + 2 * H,
        resetIn: 'in 2h'
      },
      {
        name: 'Overall',
        kind: 'weekly_all',
        scope: null,
        leftPercent: 60,
        resetsAt: now + 2 * DAY + 5 * H,
        resetIn: 'in 2d 5h'
      },
      {
        name: 'Fable',
        kind: 'weekly_scoped',
        scope: 'Fable',
        leftPercent: 0,
        resetsAt: now + 3 * DAY,
        resetIn: 'in 3d'
      }
    ])
  })
  it('suggests the API key when it is the only connection, with no headroom to read', () => {
    const codex = harness(launchOptions(input()), 'codex')
    expect(codex.connections).toHaveLength(1)
    expect(codex.connections[0]).toMatchObject({
      id: 'key',
      fallback: true,
      suggested: true,
      exhausted: false,
      headroom: null,
      windows: []
    })
    expect(codex.connectionNote).toBeNull()
  })
  it('answers no connection, and says why, for a harness Clave holds none for', () => {
    const pi = harness(launchOptions(input()), 'pi')
    expect(pi.connections).toEqual([])
    expect(pi.connectionNote).toBe(
      'Clave holds no connection for Pi: it runs on the login inside the harness.'
    )
    expect(poolsOf(HARNESS_BY_ID.pi)).toEqual([])
    expect(poolsOf(HARNESS_BY_ID.claude)).toEqual(['claude'])
  })
  it('follows the recommendation when the person opted in', () => {
    // Work renews later than Romain's week: the recommendation is Romain's on Opus.
    expect(suggestedConnection([fableOut, open()], 'work', true, OPUS)).toBe('default')
    expect(suggestedConnection([fableOut, open()], 'work', false, OPUS)).toBe('work')
  })
})

describe('the profiles', () => {
  it('reads each profile form and the default one', () => {
    const claude = harness(launchOptions(input()), 'claude')
    expect(claude.profiles).toEqual([
      { id: 'builtin-claude', name: 'Claude', form: 'terminal', default: false },
      { id: 'claude-chat', name: 'Claude (chat)', form: 'chat', default: true },
      { id: 'claude-yolo', name: 'Claude yolo', form: 'terminal', default: false },
      { id: 'chat:claude:claude-yolo', name: 'Claude yolo (chat)', form: 'chat', default: false }
    ])
  })
})
