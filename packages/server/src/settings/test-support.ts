/**
 * A settings source the tests drive by hand: in-memory lists, every call
 * recorded, the events emitted on demand. Test-only; the server's and the
 * client's settings tests import it, nothing else does.
 */
import type {
  AccountLoginJob,
  AntasphereAccountStatus,
  ClaudeAccount,
  CodexAccount,
  HelperPreference,
  IntegrationsStatus,
  LaunchProfile,
  LaunchProfilePreferences,
  SettingsEvent,
  SettingsSourceService,
  Unsubscribe,
  UsageRead,
  Workspace,
  WorkspaceState,
  // ── Lane B (harness wave): provider connections ──
  ProviderConnection,
  // Lane C of the harness wave (PRDCT-4496): the models catalogue
  ModelsCatalogView
} from './port'
import { unavailable } from './port'

const emptyProfiles = (): LaunchProfilePreferences => ({
  version: 1,
  customProfiles: [],
  globalDefaults: {},
  workspaceOverrides: {}
})

const read = (used: number): UsageRead => ({
  windows: [
    {
      key: 'session',
      label: 'Current session (5h)',
      kind: 'session',
      scope: null,
      usedPercentage: used,
      resetsAt: null,
      severity: null
    }
  ],
  fetchedAt: 1
})

/** The source as the fake holds it, plus what the test reads back. */
export class FakeSettingsSource implements SettingsSourceService {
  claude: ClaudeAccount[] = []
  codex: CodexAccount[] = []
  jobs: AccountLoginJob[] = []
  profiles: LaunchProfilePreferences = emptyProfiles()
  /** The host's helpers as the fake holds them (PRDCT-4330). */
  helperList: HelperPreference[] = [
    {
      id: 'tab-title',
      label: 'Tab titles',
      enabled: true,
      model: 'haiku',
      defaultModel: 'haiku',
      account: { kind: 'session' }
    }
  ]
  state: WorkspaceState = {
    version: 1,
    workspaces: [],
    lastActiveWorkspaceId: null,
    activeWorkspaceId: null,
    pins: [],
    pinsMigrated: true,
    // The stamp (PRDCT-3405): this fake is one instance, bumped per write.
    revision: 0,
    instance: 'fake-settings'
  }
  /** Every secret the source was handed, so a test can prove where it went and did not. */
  readonly secrets: string[] = []
  readonly calls: Array<{ method: string; args: unknown[] }> = []
  /** What the two login commands, the icon and the Antasphere account answer; unset lets them run. */
  refuse: {
    login?: boolean
    appIcon?: boolean
    antasphere?: boolean
    integrations?: boolean
    // Lane C of the harness wave (PRDCT-4496): the models catalogue
    modelsCatalog?: boolean
  } = {}
  /** The host's integrations as the fake holds them (PRDCT-4410): the key it
   *  was handed goes to `secrets`, never into this. */
  integrationsStatus: IntegrationsStatus = {
    elevenLabs: {
      configured: false,
      setAt: null,
      voiceId: null,
      voiceName: null,
      modelId: 'eleven_flash_v2_5',
      checkedAt: null,
      tier: null,
      charactersUsed: null,
      charactersLimit: null,
      lastError: null
    }
  }
  /** The Antasphere account as the fake holds it, moved by the four commands. */
  antasphereStatus: AntasphereAccountStatus = {
    phase: 'signed-out',
    account: null,
    issuerHost: 'issuer.test',
    signedInAt: null,
    expiresAt: null,
    renewable: false,
    loginStartedAt: null,
    lastFailure: null,
    secureStorage: true
  }
  private readonly listeners = new Set<(event: SettingsEvent) => void>()
  private n = 0

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }
  emit(event: SettingsEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
  listenerCount(): number {
    return this.listeners.size
  }

  readonly claudeAccounts: SettingsSourceService['claudeAccounts'] = {
    list: () => {
      this.record('claudeAccounts.list')
      return this.claude
    },
    migrated: () => ['migrated-1'],
    add: (label) => {
      this.record('claudeAccounts.add', label)
      const account: ClaudeAccount = {
        id: `c${++this.n}`,
        label,
        hasToken: false,
        tokenSetAt: null,
        tokenExpiresAt: null,
        tokenInvalid: false
      }
      this.claude = [...this.claude, account]
      return account
    },
    rename: (id, label) => {
      this.record('claudeAccounts.rename', id, label)
      const found = this.claude.find((a) => a.id === id)
      if (!found) return undefined
      const next = { ...found, ...(label !== undefined && { label }) }
      this.claude = this.claude.map((a) => (a.id === id ? next : a))
      return next
    },
    reorder: (ids) => {
      this.record('claudeAccounts.reorder', [...ids])
    },
    remove: (id) => {
      this.record('claudeAccounts.remove', id)
      const before = this.claude.length
      this.claude = this.claude.filter((a) => a.id !== id)
      return this.claude.length < before
    },
    setToken: (id, token) => {
      this.record('claudeAccounts.setToken', id)
      this.secrets.push(token)
      // The manager's own refusal, a plain Error with the sentence for the person.
      if (!token.startsWith('sk-ant-'))
        throw new Error('That does not look like a Claude Code token (expected sk-ant-…).')
      this.claude = this.claude.map((a) =>
        a.id === id ? { ...a, hasToken: true, tokenSetAt: 2, tokenExpiresAt: 3 } : a
      )
      return read(10)
    },
    clearToken: (id) => {
      this.record('claudeAccounts.clearToken', id)
    }
  }
  readonly codexAccounts: SettingsSourceService['codexAccounts'] = {
    list: () => this.codex,
    add: (label, kind) => {
      this.record('codexAccounts.add', label, kind)
      const account: CodexAccount = { id: `x${++this.n}`, label, kind, hasCredential: false }
      this.codex = [...this.codex, account]
      return account
    },
    rename: (id, label) => {
      const found = this.codex.find((a) => a.id === id)
      return found ? { ...found, ...(label !== undefined && { label }) } : undefined
    },
    reorder: (ids) => {
      this.record('codexAccounts.reorder', [...ids])
    },
    remove: (id) => {
      const before = this.codex.length
      this.codex = this.codex.filter((a) => a.id !== id)
      return this.codex.length < before
    },
    clearCredential: (id) => {
      this.record('codexAccounts.clearCredential', id)
    }
  }
  readonly logins: SettingsSourceService['logins'] = {
    start: (provider, accountId) => {
      this.record('logins.start', provider, accountId)
      if (this.refuse.login) throw unavailable('login', 'This server has no terminal for a login.')
      const job: AccountLoginJob = {
        id: `j${++this.n}`,
        provider,
        accountId,
        status: 'running',
        url: 'https://example.test/login',
        awaitingCode: false,
        message: null,
        startedAt: 1
      }
      this.jobs = [...this.jobs, job]
      return job
    },
    startApiKey: async (accountId, apiKey) => {
      this.record('logins.startApiKey', accountId)
      this.secrets.push(apiKey)
      if (this.refuse.login) throw unavailable('login', 'This server has no terminal for a login.')
      const job: AccountLoginJob = {
        id: `j${++this.n}`,
        provider: 'codex',
        accountId,
        status: 'done',
        url: null,
        awaitingCode: false,
        message: null,
        startedAt: 1
      }
      this.jobs = [...this.jobs, job]
      return job
    },
    input: (jobId, text) => {
      this.record('logins.input', jobId, text)
      if (this.refuse.login) throw unavailable('login', 'This server runs no login to type into.')
    },
    cancel: (jobId) => {
      this.record('logins.cancel', jobId)
      if (this.refuse.login) throw unavailable('login', 'This server runs no login to cancel.')
    },
    list: () => this.jobs
  }
  readonly usage: SettingsSourceService['usage'] = {
    readClaude: async (accountId, force) => {
      this.record('usage.readClaude', accountId, force)
      return read(30)
    },
    claudeSnapshot: () => ({ default: read(30) }),
    readCodex: async (accountId, force) => {
      this.record('usage.readCodex', accountId, force)
      return { error: 'Sign in to Codex CLI with ChatGPT to see your usage limits.' }
    },
    codexSnapshot: () => ({}),
    readPi: (range) => {
      this.record('usage.readPi', range)
      return {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: 0.1,
        sessions: 1,
        range
      }
    }
  }
  readonly launchProfiles: SettingsSourceService['launchProfiles'] = {
    list: () => this.profiles,
    upsert: (profile: LaunchProfile) => {
      this.record('launchProfiles.upsert', profile)
      this.profiles = {
        ...this.profiles,
        customProfiles: [
          ...this.profiles.customProfiles.filter((p) => p.id !== profile.id),
          profile
        ]
      }
      return this.profiles
    },
    delete: (profileId) => {
      this.record('launchProfiles.delete', profileId)
      this.profiles = {
        ...this.profiles,
        customProfiles: this.profiles.customProfiles.filter((p) => p.id !== profileId)
      }
      return this.profiles
    },
    setGlobal: (family, profileId) => {
      this.record('launchProfiles.setGlobal', family, profileId)
      return this.profiles
    },
    setWorkspace: (workspaceId, family, profileId) => {
      this.record('launchProfiles.setWorkspace', workspaceId, family, profileId)
      return this.profiles
    }
  }
  readonly helpers: SettingsSourceService['helpers'] = {
    list: () => this.helperList,
    set: (helperId, patch) => {
      this.record('helpers.set', helperId, patch)
      const known = this.helperList.find((h) => h.id === helperId)
      if (!known) throw new Error(`There is no helper "${helperId}" on this machine.`)
      this.helperList = this.helperList.map((h) =>
        h.id === helperId
          ? {
              ...h,
              ...(patch.enabled !== undefined && { enabled: patch.enabled }),
              ...(patch.model !== undefined && { model: patch.model ?? h.defaultModel }),
              ...(patch.account !== undefined && { account: patch.account })
            }
          : h
      )
      return this.helperList
    }
  }
  private integrationsHere(): void {
    if (this.refuse.integrations)
      throw unavailable('integrations', 'This server has no integrations.')
  }
  private elevenLabs(patch: Partial<IntegrationsStatus['elevenLabs']>): IntegrationsStatus {
    this.integrationsStatus = {
      elevenLabs: { ...this.integrationsStatus.elevenLabs, ...patch }
    }
    return this.integrationsStatus
  }
  readonly integrations: SettingsSourceService['integrations'] = {
    read: () => {
      this.integrationsHere()
      return this.integrationsStatus
    },
    setElevenLabsKey: (apiKey) => {
      this.record('integrations.setElevenLabsKey')
      this.integrationsHere()
      if (!apiKey.trim()) throw new Error('Paste the API key first.')
      this.secrets.push(apiKey)
      return this.elevenLabs({ configured: true, setAt: 1, checkedAt: 1, tier: 'creator' })
    },
    checkElevenLabs: () => {
      this.record('integrations.checkElevenLabs')
      this.integrationsHere()
      return this.elevenLabs({ checkedAt: 2 })
    },
    removeElevenLabsKey: () => {
      this.record('integrations.removeElevenLabsKey')
      this.integrationsHere()
      return this.elevenLabs({ configured: false, setAt: null, voiceId: null, voiceName: null })
    },
    setElevenLabsVoice: (voiceId, voiceName, modelId) => {
      this.record('integrations.setElevenLabsVoice', voiceId, voiceName, modelId)
      this.integrationsHere()
      return this.elevenLabs({ voiceId, voiceName, ...(modelId && { modelId }) })
    },
    listElevenLabsVoices: () => {
      this.record('integrations.listElevenLabsVoices')
      this.integrationsHere()
      if (!this.integrationsStatus.elevenLabs.configured)
        throw new Error('No ElevenLabs key on this machine.')
      return {
        voices: [
          { voiceId: 'v1', name: 'Voice one', category: 'premade', labels: {}, previewUrl: null }
        ]
      }
    }
  }
  readonly preferences: SettingsSourceService['preferences'] = {
    setAppIcon: (icon) => {
      this.record('preferences.setAppIcon', icon)
      if (this.refuse.appIcon) throw unavailable('appIcon', 'This server has no Dock.')
    }
  }
  readonly antasphere: SettingsSourceService['antasphere'] = {
    status: () => {
      if (this.refuse.antasphere) throw unavailable('antasphereAccount', 'No account here.')
      return this.antasphereStatus
    },
    signIn: () => {
      this.record('antasphere.signIn')
      if (this.refuse.antasphere) throw unavailable('antasphereAccount', 'No account here.')
      this.antasphereStatus = {
        ...this.antasphereStatus,
        phase: 'signing-in',
        loginStartedAt: 1,
        lastFailure: null
      }
      this.emit({ _tag: 'accounts.antasphere_changed', status: this.antasphereStatus })
      return {
        status: this.antasphereStatus,
        handoff: { url: 'https://issuer.test/authorize?state=s1', generation: 1 }
      }
    },
    confirmHandoff: (handoff) => {
      this.record('antasphere.confirmHandoff', handoff.generation)
      if (this.refuse.antasphere) throw unavailable('antasphereAccount', 'No account here.')
      return (
        this.antasphereStatus.phase === 'signing-in' &&
        handoff.generation === 1 &&
        handoff.url === 'https://issuer.test/authorize?state=s1'
      )
    },
    cancel: () => {
      this.record('antasphere.cancel')
      if (this.refuse.antasphere) throw unavailable('antasphereAccount', 'No account here.')
      this.antasphereStatus = {
        ...this.antasphereStatus,
        phase: 'signed-out',
        loginStartedAt: null,
        lastFailure: 'cancelled'
      }
      this.emit({ _tag: 'accounts.antasphere_changed', status: this.antasphereStatus })
      return this.antasphereStatus
    },
    signOut: () => {
      this.record('antasphere.signOut')
      if (this.refuse.antasphere) throw unavailable('antasphereAccount', 'No account here.')
      this.antasphereStatus = { ...this.antasphereStatus, phase: 'signed-out', account: null }
      this.emit({ _tag: 'accounts.antasphere_changed', status: this.antasphereStatus })
      return this.antasphereStatus
    },
    dismiss: () => {
      this.record('antasphere.dismiss')
      if (this.refuse.antasphere) throw unavailable('antasphereAccount', 'No account here.')
      this.antasphereStatus = { ...this.antasphereStatus, lastFailure: null }
      this.emit({ _tag: 'accounts.antasphere_changed', status: this.antasphereStatus })
      return this.antasphereStatus
    }
  }
  readonly workspaces: SettingsSourceService['workspaces'] = {
    load: () => this.state,
    updateRegistry: (workspaces: ReadonlyArray<Workspace>, origin, base) => {
      this.record('workspaces.updateRegistry', [...workspaces], origin, ...(base ? [base] : []))
      if (base && (base.instance !== this.state.instance || base.revision !== this.state.revision))
        return { ok: false as const, reason: 'stale' as const }
      this.state = { ...this.state, workspaces: [...workspaces], revision: this.state.revision + 1 }
      this.emit({
        _tag: 'workspaces.state_changed',
        workspaces: this.state.workspaces,
        pins: this.state.pins,
        origin: origin ?? null,
        revision: this.state.revision,
        instance: this.state.instance
      })
      return {
        ok: true as const,
        workspaces: this.state.workspaces,
        pins: this.state.pins,
        revision: this.state.revision,
        instance: this.state.instance
      }
    },
    updatePins: (scope, pins, origin) => {
      this.record('workspaces.updatePins', scope, [...pins], origin)
      if (scope === 'bad') return { ok: false as const, reason: 'invalid-key' as const }
      this.state = { ...this.state, pins: [...pins], revision: this.state.revision + 1 }
      this.emit({
        _tag: 'workspaces.state_changed',
        workspaces: this.state.workspaces,
        pins: this.state.pins,
        origin: origin ?? null,
        revision: this.state.revision,
        instance: this.state.instance
      })
      return {
        ok: true as const,
        workspaces: this.state.workspaces,
        pins: this.state.pins,
        revision: this.state.revision,
        instance: this.state.instance
      }
    },
    setLastActive: (workspaceId) => {
      this.record('workspaces.setLastActive', workspaceId)
      this.state = { ...this.state, lastActiveWorkspaceId: workspaceId }
    }
  }
  subscribe = (listener: (event: SettingsEvent) => void): Unsubscribe => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  // ── Lane B (harness wave): provider connections ──
  /** The host's provider connections as the fake holds them (PRDCT-4426). */
  connections: ProviderConnection[] = []
  /** How many keys `setKey` was handed: the fake keeps the count, never a key. */
  providerKeysSet = 0
  private connectionsChanged(): void {
    this.emit({ _tag: 'accounts.providers_changed', connections: [...this.connections] })
  }
  readonly providerConnections: SettingsSourceService['providerConnections'] = {
    list: () => {
      this.record('providerConnections.list')
      return this.connections
    },
    add: (input) => {
      this.record('providerConnections.add', input)
      const connection: ProviderConnection = {
        id: `pc-${++this.n}`,
        label: input.label?.trim() || input.company,
        company: input.company,
        kind: 'key',
        pool: input.company,
        endpoints: [{ wireFormat: 'openai-chat', baseUrl: 'https://provider.example.test/v1' }],
        needsKey: true,
        hasKey: false,
        keySetAt: null,
        createdAt: 1
      }
      this.connections = [...this.connections, connection]
      this.connectionsChanged()
      return connection
    },
    rename: (id, label) => {
      this.record('providerConnections.rename', id, label)
      const known = this.connections.find((c) => c.id === id)
      if (!known) throw new Error('No such connection.')
      const renamed = { ...known, label }
      this.connections = this.connections.map((c) => (c.id === id ? renamed : c))
      this.connectionsChanged()
      return renamed
    },
    remove: (id) => {
      this.record('providerConnections.remove', id)
      const existed = this.connections.some((c) => c.id === id)
      this.connections = this.connections.filter((c) => c.id !== id)
      if (existed) this.connectionsChanged()
      return existed
    },
    setKey: (id, apiKey) => {
      // The key itself is never recorded, stored or returned.
      this.record('providerConnections.setKey', id)
      const known = this.connections.find((c) => c.id === id)
      if (!known) throw new Error('No such connection.')
      if (!apiKey.trim()) throw new Error('Paste the key first.')
      this.providerKeysSet++
      const keyed = { ...known, hasKey: true, keySetAt: 2 }
      this.connections = this.connections.map((c) => (c.id === id ? keyed : c))
      this.connectionsChanged()
      return keyed
    }
  }
  // Lane C of the harness wave (PRDCT-4496): the models catalogue as the
  // fake holds it; `read` filters it to the ids asked for, in their order.
  catalog: ModelsCatalogView = {
    fetchedAt: 1,
    stale: false,
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: false, toolCall: true }]
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        models: [
          {
            id: 'old',
            name: 'Old',
            reasoning: false,
            toolCall: false,
            status: 'deprecated',
            contextLimit: 8000
          }
        ]
      }
    ]
  }
  readonly modelsCatalog: SettingsSourceService['modelsCatalog'] = {
    read: (input) => {
      this.record('modelsCatalog.read', input)
      if (this.refuse.modelsCatalog)
        throw unavailable('modelsCatalog', 'This server has no models catalogue.')
      const ids = input.providerIds
      if (!ids) return this.catalog
      return {
        ...this.catalog,
        providers: ids.flatMap((id) => this.catalog.providers.filter((p) => p.id === id))
      }
    }
  }
}
