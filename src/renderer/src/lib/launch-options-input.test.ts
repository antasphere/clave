import { describe, expect, it, vi } from 'vitest'
import { launchOptions } from '../../../shared/launch-options'
import { HARNESSES } from '../../../shared/harness'
import type { ServerSettings } from '../store/server-settings-state'
import type { AccountUsageSummary } from '../store/usage-store'
import type { ClaudeAccount } from '../../../preload/index.d'
import type { AccountSources } from './session-accounts'
import type { ProviderLaunchConnection } from './launch-source'
import type {
  CatalogModelView,
  ModelsCatalogView
} from '@clave/contract/settings/models-catalog-view'
import {
  launchModelsOf,
  localLaunchOptionsInput,
  poolConnections,
  serverLaunchOptionsInput
} from './launch-options-input'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type { ProviderCompanyId } from '@clave/contract/settings/provider-catalogue'
import type { ProviderConnection } from '../../../preload/index.d'
import { useProviderConnectionsStore } from '../store/provider-connections-store'

// The session store reads localStorage at import; nothing here touches it.
vi.mock('../store/session-store', () => ({ useSessionStore: {} }))

// This Mac's stores, as `localLaunchOptionsInput` reads them: the launcher's
// source and the account sources, set per test.
const local = vi.hoisted(() => ({ sources: null as unknown, selected: 'default' }))
vi.mock('./launch-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./launch-source')>()
  return {
    ...actual,
    localLaunchSource: () => ({
      serverId: 'local',
      name: 'This Mac',
      ready: true,
      profilesFor: () => [],
      selectedProfileId: () => undefined,
      accounts: () => [],
      selectedAccountId: (family: string) => (family === 'claude' ? local.selected : null),
      chatProfileId: () => undefined,
      connections: () => [],
      providerConnections: () => [],
      catalog: () => null
    })
  }
})
vi.mock('./session-accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-accounts')>()
  return { ...actual, currentAccountSources: () => local.sources }
})

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
    expect(input.connections('nope' as never)).toEqual([])
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

  it("resolves the server's open profile: its chat default in a chat mode, its default profile in a terminal one", () => {
    // The server's default profile is the built-in terminal; its chat default the built-in chat.
    expect(input.defaultProfileId('claude')).toBe('builtin-claude')
    expect(input.openProfileId('claude')).toBe('claude-chat')
    expect(input.openProfileId('codex')).toBe('codex-chat')
    // No chat view: the default profile, whatever the mode.
    expect(input.openProfileId('antigravity')).toBe('builtin-antigravity')
    const terminal = serverLaunchOptionsInput('srv', 'Studio box', settings, {
      ...facts,
      interactionMode: 'terminal'
    })
    expect(terminal.openProfileId('claude')).toBe('builtin-claude')
  })

  it("says the server's own default as defaultModel, the launcher's row model as launcherModel", () => {
    const withRow = launchOptions(
      serverLaunchOptionsInput('srv', 'Studio box', settings, {
        ...facts,
        harnessSettings: { claude: { preferredModel: 'opus' } }
      })
    ).harnesses.find((h) => h.id === 'claude')!
    expect(withRow.defaultModel).toBeNull()
    expect(withRow.launcherModel).toBe('opus')
  })
})

describe("Pi's and OpenCode's provider pools (PRDCT-4496)", () => {
  const view = (
    id: string,
    company: ProviderCompanyId,
    over: Partial<ProviderConnection> = {}
  ): ProviderConnection => ({
    id,
    label: `${id} label`,
    company,
    kind: 'key',
    pool: company,
    endpoints: [{ wireFormat: 'openai-chat', baseUrl: 'https://made-up.invalid/v1' }],
    needsKey: true,
    hasKey: true,
    keySetAt: 1,
    createdAt: 1,
    ...over
  })

  it("lists each machine's stored connections under their company's pool, from lane B's store", () => {
    useProviderConnectionsStore.setState({
      byMachine: {
        [LOCAL_SERVER_ID]: {
          connections: [
            view('mac-kimi', 'moonshot'),
            view('mac-ds', 'deepseek', { hasKey: false, keySetAt: null })
          ],
          loading: false,
          error: null
        },
        srv: {
          connections: [view('srv-ollama', 'ollama', { needsKey: false, hasKey: false })],
          loading: false,
          error: null
        }
      }
    })
    const before = local.sources
    try {
      local.sources = {
        claude: [],
        codex: [],
        claudeUsage: {},
        codexUsage: {},
        servers: {}
      } satisfies AccountSources
      const mac = launchOptions(
        localLaunchOptionsInput({ ...facts, agents: [], preferRecommended: false })
      )
      for (const id of ['pi', 'opencode']) {
        const h = mac.harnesses.find((x) => x.id === id)!
        expect(h.connections.map((c) => [c.pool, c.id, c.usable])).toEqual([
          ['moonshot', 'mac-kimi', true],
          ['deepseek', 'mac-ds', false]
        ])
        expect(h.connectionNote).toBeNull()
      }
      const server = launchOptions(serverLaunchOptionsInput('srv', 'Studio box', settings, facts))
      expect(
        server.harnesses.find((x) => x.id === 'pi')!.connections.map((c) => [c.pool, c.id])
      ).toEqual([['ollama', 'srv-ollama']])
      // The pool answers through the one shape of a connection.
      expect(poolConnections(local.sources as AccountSources, 'srv', 'ollama')).toEqual([
        {
          id: 'srv-ollama',
          label: 'srv-ollama label',
          pool: 'ollama',
          company: 'ollama',
          kind: 'key',
          usable: true,
          reportsUsage: false,
          usage: undefined
        }
      ])
      expect(poolConnections(local.sources as AccountSources, 'srv', 'moonshot')).toEqual([])
    } finally {
      local.sources = before
      useProviderConnectionsStore.setState({ byMachine: {} })
    }
  })
})

describe('localLaunchOptionsInput', () => {
  const weekAt = (used: number, resetsAt: number): AccountUsageSummary => {
    const w = {
      kind: 'weekly_all',
      scope: null,
      usedPercentage: used,
      severity: used >= 100 ? 'critical' : 'normal',
      resetsAt
    }
    return { status: 'ready', error: null, tightest: w, windows: [w] } as AccountUsageSummary
  }
  const DAY = 86_400_000
  // The selected one spent; next along the ring "Later" (its week resets in
  // five days), the recommendation "Sooner" (its week resets tomorrow).
  local.sources = {
    claude: [
      claudeAccount('default', 'Default'),
      claudeAccount('later', 'Later'),
      claudeAccount('sooner', 'Sooner')
    ],
    codex: [],
    claudeUsage: {
      default: weekAt(100, NOW + DAY),
      later: weekAt(20, NOW + 5 * DAY),
      sooner: weekAt(40, NOW + DAY)
    },
    codexUsage: {},
    servers: {}
  } satisfies AccountSources
  const suggestedOf = (preferRecommended: boolean): string[] =>
    launchOptions(localLaunchOptionsInput({ ...facts, agents: [], preferRecommended }))
      .harnesses.find((h) => h.id === 'claude')!
      .connections.filter((c) => c.suggested)
      .map((c) => c.id)

  it('marks the recommended connection when the person opted in, the next along when not', () => {
    expect(suggestedOf(true)).toEqual(['sooner'])
    expect(suggestedOf(false)).toEqual(['later'])
  })

  it("resolves this Mac's open profile: the chat default in a chat mode, the selected profile in a terminal one", () => {
    // The launch profile store's defaults: the built-in terminal selected,
    // its chat form the built-in chat.
    const chat = localLaunchOptionsInput({ ...facts, agents: [], preferRecommended: false })
    expect(chat.openProfileId('claude')).toBe('claude-chat')
    expect(chat.openProfileId('pi')).toBe('builtin-pi')
    const terminal = localLaunchOptionsInput({
      ...facts,
      interactionMode: 'terminal',
      agents: [],
      preferRecommended: false
    })
    expect(terminal.openProfileId('claude')).toBe('builtin-claude')
  })
})

describe('launchModelsOf', () => {
  const none = { profilesFor: () => [], catalog: () => null, providerConnections: () => [] }
  // A machine with two stored connections and one saved Pi profile; the
  // catalogue lists both companies' models (a deprecated one hidden).
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
      { id: 'deepseek', name: 'DeepSeek', models: [catalogModel('deepseek-chat')] },
      {
        id: 'mistral',
        name: 'Mistral',
        models: [catalogModel('devstral'), catalogModel('old', true)]
      }
    ]
  }
  const stored = (
    view: ModelsCatalogView | 'loading' | null,
    connections: readonly ProviderLaunchConnection[] = [
      { id: 'c-mi', label: 'Mistral work', company: 'mistral' },
      { id: 'c-ds', label: 'DeepSeek', company: 'deepseek' }
    ]
  ): Parameters<typeof launchModelsOf>[0] => ({
    profilesFor: (family) =>
      family === 'pi'
        ? ([{ id: 'pi-glm', family: 'pi', pi: { model: 'glm-5' } }] as ReturnType<
            Parameters<typeof launchModelsOf>[0]['profilesFor']
          >)
        : [],
    catalog: () => view,
    providerConnections: () => connections
  })
  const DEFAULT = { id: null, label: 'Default', family: 'Default' }

  it("lists Pi's default, the catalogue models of each connection's company in order, then the pinned", () => {
    expect(launchModelsOf(stored(VIEW), 'pi', 'unavailable')).toEqual([
      DEFAULT,
      { id: 'devstral', label: 'devstral name', family: 'Mistral' },
      { id: 'deepseek-chat', label: 'deepseek-chat name', family: 'DeepSeek' },
      { id: 'glm-5', label: 'glm-5', family: 'glm-5' }
    ])
  })
  it("lists OpenCode's default and the catalogue models, no pinned model", () => {
    expect(launchModelsOf(stored(VIEW), 'opencode', 'unavailable')).toEqual([
      DEFAULT,
      { id: 'devstral', label: 'devstral name', family: 'Mistral' },
      { id: 'deepseek-chat', label: 'deepseek-chat name', family: 'DeepSeek' }
    ])
  })
  it('answers the default and the pinned while the catalogue is read', () => {
    expect(launchModelsOf(stored('loading'), 'pi', 'unavailable')).toEqual([
      DEFAULT,
      { id: 'glm-5', label: 'glm-5', family: 'glm-5' }
    ])
    expect(launchModelsOf(stored('loading'), 'opencode', 'unavailable')).toEqual([DEFAULT])
  })
  it('answers the default and the pinned with no connection stored', () => {
    expect(launchModelsOf(stored(VIEW, []), 'pi', 'unavailable')).toEqual([
      DEFAULT,
      { id: 'glm-5', label: 'glm-5', family: 'glm-5' }
    ])
    expect(launchModelsOf(stored(VIEW, []), 'opencode', 'unavailable')).toEqual([DEFAULT])
  })
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
