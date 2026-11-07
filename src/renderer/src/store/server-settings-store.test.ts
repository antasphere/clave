import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetSettingsEvent } from '../../../preload/fleet-types'
import type { LaunchProfile, LaunchProfilePreferences } from '../../../shared/agent-launch'
import type {
  ClaudeAccount,
  CodexAccount,
  UsageError,
  UsageLimits,
  UsageWindow
} from '../../../preload/index.d'

let store: typeof import('./server-settings-store')
let fleet: typeof import('./fleet-store')

const api = {
  fleetAccounts: vi.fn(),
  fleetLaunchSettings: vi.fn(),
  fleetUsageSnapshot: vi.fn(),
  fleetUsage: vi.fn(),
  fleetLaunchProfileUpsert: vi.fn(),
  onFleetSettingsEvent: vi.fn()
}
let emit: (event: FleetSettingsEvent) => void = () => {}

const bare = { tokenSetAt: null, tokenExpiresAt: null, tokenInvalid: false }
const claude = (id: string, label: string): ClaudeAccount => ({
  id,
  label,
  hasToken: true,
  ...bare
})
const codex = (id: string, label: string): CodexAccount => ({
  id,
  label,
  kind: 'apiKey',
  hasCredential: true
})
const cap = (key: string, usedPercentage: number): UsageWindow => ({
  key,
  label: key,
  kind: key === '5h' ? 'session' : 'weekly_all',
  scope: null,
  usedPercentage,
  resetsAt: null,
  severity: null
})
const read = (fetchedAt: number, ...windows: UsageWindow[]): UsageLimits => ({ windows, fetchedAt })
const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0))
const PROFILES: LaunchProfilePreferences = {
  version: 1,
  customProfiles: [],
  globalDefaults: {},
  workspaceOverrides: {}
}

beforeAll(async () => {
  const memory = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key)
  })
  // usage-store binds focus and visibility at load; a bare object stands in.
  vi.stubGlobal('window', { electronAPI: api, addEventListener: () => {} })
  vi.stubGlobal('document', { addEventListener: () => {}, hidden: false })
  api.onFleetSettingsEvent.mockImplementation((callback: typeof emit) => {
    emit = callback
    return () => {}
  })
  fleet = await import('./fleet-store')
  store = await import('./server-settings-store')
  store.startServerSettingsEvents()
})

beforeEach(() => {
  for (const fn of Object.values(api)) if (fn !== api.onFleetSettingsEvent) fn.mockReset()
  store.useServerSettingsStore.setState({ byServer: {} })
  fleet.useFleetStore.setState({
    connections: [{ id: 's1', name: 'Server', url: 'http://server.example:7300', enabled: true }],
    statuses: { s1: { serverId: 's1', state: 'connected' } }
  })
  api.fleetAccounts.mockResolvedValue({
    claude: [claude('w1', 'Work'), { ...claude('default', 'Machine login'), hasToken: false }],
    codex: [codex('k1', 'Key')],
    migrated: ['w1']
  })
  api.fleetLaunchSettings.mockResolvedValue({
    profiles: PROFILES,
    claudeAccounts: [],
    codexAccounts: []
  })
  api.fleetUsageSnapshot.mockImplementation(async (_id: string, provider: string) =>
    provider === 'claude'
      ? { default: read(100, cap('5h', 10), cap('7d', 60)), w1: { error: 'Rate limited' } }
      : {}
  )
  api.fleetUsage.mockResolvedValue(read(200, cap('5h', 5)))
})

describe("a server's settings as the Mac sees them", () => {
  it('fills the lists, the Default first, and summarises the snapshot', async () => {
    await store.loadServerSettings('s1')
    const s = store.serverSettingsFor('s1')
    expect(s.status).toBe('ready')
    expect(s.claude.map((a) => a.id)).toEqual(['default', 'w1'])
    expect(s.claude[0].label).toBe('Machine login')
    expect(s.codex.map((a) => a.id)).toEqual(['default', 'k1'])
    expect(s.migrated).toEqual(['w1'])
    expect(s.profiles).toEqual(PROFILES)
    expect(s.usage.claude.default.status).toBe('ready')
    expect(s.usage.claude.default.tightest?.key).toBe('7d')
    expect(s.usage.claude.default.fetchedAt).toBe(100)
  })

  it('reads an error snapshot entry live and forced, a missing one live unforced', async () => {
    await store.loadServerSettings('s1')
    await flush()
    expect(api.fleetUsage).toHaveBeenCalledWith('s1', 'claude', 'w1', true)
    expect(api.fleetUsage).toHaveBeenCalledWith('s1', 'codex', 'k1', false)
    expect(api.fleetUsage).not.toHaveBeenCalledWith('s1', 'claude', 'default', expect.anything())
    expect(store.serverSettingsFor('s1').usage.claude.w1.status).toBe('ready')
    expect(store.serverSettingsFor('s1').usage.claude.w1.fetchedAt).toBe(200)
  })

  it('coalesces concurrent loads of one server', async () => {
    await Promise.all([store.loadServerSettings('s1'), store.loadServerSettings('s1')])
    expect(api.fleetAccounts).toHaveBeenCalledTimes(1)
  })

  it('reports a failed load as one safe sentence', async () => {
    api.fleetAccounts.mockRejectedValue(new Error('ENOENT /srv/secret/path'))
    await store.loadServerSettings('s1')
    const s = store.serverSettingsFor('s1')
    expect(s.status).toBe('error')
    expect(s.error).not.toContain('/srv')
  })

  it('replaces a list on an accounts event, keeping the Default first', async () => {
    await store.loadServerSettings('s1')
    emit({ serverId: 's1', kind: 'claude-accounts', accounts: [claude('n1', 'New')] })
    expect(store.serverSettingsFor('s1').claude.map((a) => a.id)).toEqual(['default', 'n1'])
    emit({ serverId: 's2', kind: 'codex-accounts', accounts: [codex('c2', 'Other')] })
    expect(store.serverSettingsFor('s2').codex.map((a) => a.id)).toEqual(['default', 'c2'])
  })

  it('updates one account on a usage event', async () => {
    await store.loadServerSettings('s1')
    await flush()
    const error: UsageError = { error: 'Token refused', reason: 'unauthorized' }
    emit({ serverId: 's1', kind: 'claude-usage', accountId: 'w1', result: error })
    const usage = store.serverSettingsFor('s1').usage.claude
    expect(usage.w1.status).toBe('error')
    expect(usage.w1.error).toBe('Token refused')
    expect(usage.default.status).toBe('ready')
  })

  it('refreshes every account of a provider, forced', async () => {
    await store.loadServerSettings('s1')
    await flush()
    api.fleetUsage.mockClear()
    await store.refreshServerUsage('s1', 'claude')
    expect(api.fleetUsage.mock.calls).toEqual([
      ['s1', 'claude', 'default', true],
      ['s1', 'claude', 'w1', true]
    ])
  })

  it('reads a server again when it reconnects, and drops it once removed', async () => {
    await store.loadServerSettings('s1')
    await flush()
    fleet.useFleetStore.setState({ statuses: { s1: { serverId: 's1', state: 'reconnecting' } } })
    expect(api.fleetAccounts).toHaveBeenCalledTimes(1)
    fleet.useFleetStore.setState({ statuses: { s1: { serverId: 's1', state: 'connected' } } })
    await flush()
    expect(api.fleetAccounts).toHaveBeenCalledTimes(2)
    fleet.useFleetStore.setState({ connections: [] })
    expect(store.useServerSettingsStore.getState().byServer.s1).toBeUndefined()
  })

  it("keeps a list pushed while the load was out, over the load's older answer", async () => {
    let answer: (value: unknown) => void = () => {}
    api.fleetAccounts.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const load = store.loadServerSettings('s1')
    await flush()
    emit({ serverId: 's1', kind: 'claude-accounts', accounts: [claude('new', 'New')] })
    answer({ claude: [claude('w1', 'Work')], codex: [codex('k1', 'Key')], migrated: [] })
    await load
    const ids = store.serverSettingsFor('s1').claude.map((a) => a.id)
    expect(ids).toContain('new')
    expect(ids).not.toContain('w1')
    expect(store.serverSettingsFor('s1').codex.map((a) => a.id)).toEqual(['default', 'k1'])
  })

  it('keeps the newer read when an older one lands after it', async () => {
    await store.loadServerSettings('s1')
    emit({
      serverId: 's1',
      kind: 'claude-usage',
      accountId: 'w1',
      result: read(300, cap('5h', 50))
    })
    emit({ serverId: 's1', kind: 'claude-usage', accountId: 'w1', result: read(200, cap('5h', 5)) })
    expect(store.serverSettingsFor('s1').usage.claude.w1.fetchedAt).toBe(300)
    expect(store.serverSettingsFor('s1').usage.claude.w1.tightest?.usedPercentage).toBe(50)
  })

  it('lets a read or a load in flight for a removed server land nowhere', async () => {
    await store.loadServerSettings('s1')
    let answerRead: (value: unknown) => void = () => {}
    api.fleetUsage.mockImplementation(() => new Promise((resolve) => (answerRead = resolve)))
    const reading = store.readServerUsage('s1', 'claude', 'w1', true)
    let answerLoad: (value: unknown) => void = () => {}
    api.fleetAccounts.mockImplementation(() => new Promise((resolve) => (answerLoad = resolve)))
    const loading = store.loadServerSettings('s1')
    await flush()
    fleet.useFleetStore.setState({ connections: [], statuses: {} })
    expect(store.useServerSettingsStore.getState().byServer.s1).toBeUndefined()
    answerRead(read(900, cap('5h', 1)))
    answerLoad({ claude: [claude('w1', 'Work')], codex: [], migrated: [] })
    await reading
    await loading
    expect(store.useServerSettingsStore.getState().byServer.s1).toBeUndefined()
  })

  it('replaces the profiles with the answer of a write', async () => {
    const mine: LaunchProfile = {
      id: 'p1',
      name: 'Mine',
      family: 'claude',
      command: ['claude'],
      additionalArgs: []
    }
    const written: LaunchProfilePreferences = { ...PROFILES, customProfiles: [mine] }
    api.fleetLaunchProfileUpsert.mockResolvedValue(written)
    await store.saveServerLaunchProfile('s1', mine)
    expect(api.fleetLaunchProfileUpsert).toHaveBeenCalledWith('s1', mine)
    const settings = store.serverSettingsFor('s1')
    expect(settings.profiles).toEqual(written)
    expect(store.serverProfilesFor(settings, 'claude').some((p) => p.id === 'p1')).toBe(true)
  })
})
