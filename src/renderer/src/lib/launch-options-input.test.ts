import { describe, expect, it, vi } from 'vitest'
import { launchOptions } from '../../../shared/launch-options'
import { HARNESSES } from '../../../shared/harness'
import type { ServerSettings } from '../store/server-settings-state'
import type { AccountUsageSummary } from '../store/usage-store'
import type { ClaudeAccount } from '../../../preload/index.d'
import { launchModelsOf, serverLaunchOptionsInput } from './launch-options-input'

// The session store reads localStorage at import; nothing here touches it.
vi.mock('../store/session-store', () => ({ useSessionStore: {} }))

/**
 * `clave_launch_options` for a connected server, as the window assembles it
 * (PRDCT-4485): the facts come from the settings this Mac keeps of the
 * server, the Mac never checks a server's harnesses, and the rules are the
 * shared function's.
 */
const NOW = Date.UTC(2026, 10, 13, 12)
const week = (used: number): AccountUsageSummary => {
  const w = {
    kind: 'weekly_all',
    scope: null,
    usedPercentage: used,
    severity: used >= 100 ? 'critical' : 'normal',
    resetsAt: NOW + 2 * 3_600_000
  }
  return { status: 'ready', error: null, tightest: w, windows: [w] } as AccountUsageSummary
}
const claudeAccount = (id: string, label: string): ClaudeAccount => ({
  id,
  label,
  hasToken: true,
  tokenSetAt: null,
  tokenExpiresAt: null,
  tokenInvalid: false
})
const settings: ServerSettings = {
  status: 'ready',
  error: null,
  claude: [claudeAccount('default', 'Default'), claudeAccount('srv-2', 'Team')],
  codex: [{ id: 'k1', label: 'Key', kind: 'apiKey', hasCredential: true }],
  migrated: [],
  listed: { claude: true, codex: true },
  profiles: {
    version: 1,
    customProfiles: [
      {
        id: 'pi-glm',
        name: 'Pi GLM',
        family: 'pi',
        command: ['pi'],
        additionalArgs: [],
        pi: { model: 'glm-5' }
      },
      {
        id: 'pi-glm-2',
        name: 'Pi GLM again',
        family: 'pi',
        command: ['pi'],
        additionalArgs: [],
        pi: { model: 'glm-5' }
      },
      {
        id: 'pi-kimi',
        name: 'Pi Kimi',
        family: 'pi',
        command: ['pi'],
        additionalArgs: [],
        pi: { model: 'kimi-k3' }
      }
    ],
    globalDefaults: {},
    workspaceOverrides: {}
  },
  usage: { claude: { default: week(100), 'srv-2': week(30) }, codex: {} }
}
const facts = {
  harnessSettings: {},
  interactionMode: 'chat' as const,
  codexModels: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
  now: NOW
}

describe('serverLaunchOptionsInput', () => {
  const input = serverLaunchOptionsInput('srv', 'Studio box', settings, facts)
  const answer = launchOptions(input)

  it('names the server, and lists every harness with installed unknown: the Mac never checks a server', () => {
    expect(answer.machine).toEqual({ id: 'srv', name: 'Studio box' })
    expect(HARNESSES.map((h) => input.presence(h.id))).toEqual(HARNESSES.map(() => undefined))
    expect(answer.harnesses.map((h) => [h.id, h.installed])).toEqual(
      HARNESSES.map((h) => [h.id, null])
    )
    expect(answer.notInstalled).toEqual([])
  })

  it("builds each pool from the server's accounts and usage, the first listed selected", () => {
    expect(input.connections('claude').map((c) => [c.id, c.label, c.usable])).toEqual([
      ['default', 'Default', true],
      ['srv-2', 'Team', true]
    ])
    expect(input.connections('codex')).toEqual([
      { id: 'k1', label: 'Key', usable: true, fallback: true, usage: undefined }
    ])
    expect(input.selectedConnectionId('claude')).toBe('default')
    expect(input.connections('nope')).toEqual([])
    const claude = answer.harnesses.find((h) => h.id === 'claude')!
    expect(claude.connections.map((c) => [c.id, c.exhausted, c.suggested])).toEqual([
      ['default', true, false],
      ['srv-2', false, true]
    ])
    expect(claude.connections[0].windows[0]).toMatchObject({ leftPercent: 0, resetIn: 'in 2h' })
  })

  it("offers Pi's Default and the distinct models the server's Pi profiles pin", () => {
    expect(input.models('pi')).toEqual([
      { id: null, label: 'Default', family: 'Default' },
      { id: 'glm-5', label: 'glm-5', family: 'glm-5' },
      { id: 'kimi-k3', label: 'kimi-k3', family: 'kimi-k3' }
    ])
    expect(input.models('codex')).toEqual([{ id: 'gpt-5.5', label: 'GPT-5.5', family: 'GPT-5.5' }])
    expect(input.models('antigravity')).toEqual([])
  })

  it("names the server's default profile, and leaves the pick to the server's pool", () => {
    const claude = answer.harnesses.find((h) => h.id === 'claude')!
    expect(claude.profiles.filter((p) => p.default)).toHaveLength(1)
    expect(input.preferRecommended).toBe(false)
    expect(input.launchModel('claude', undefined)).toBeUndefined()
  })
})

describe('launchModelsOf', () => {
  const none = { profilesFor: () => [] }
  it('reads a Codex list that failed or came back empty as unavailable', () => {
    expect(launchModelsOf(none, 'codex', 'unavailable')).toBe('unavailable')
    expect(launchModelsOf(none, 'codex', [])).toBe('unavailable')
  })
  it("names Claude's families as the launcher does", () => {
    const models = launchModelsOf(none, 'claude', 'unavailable')
    expect(models).not.toBe('unavailable')
    expect((models as readonly { family: string }[]).every((m) => /^[A-Z]/.test(m.family))).toBe(
      true
    )
  })
})
