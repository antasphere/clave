import { afterEach, describe, expect, it, vi } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import type { Session } from '../store/session-types'
import type { ClaudeAccount } from '../../../preload/index.d'
import { useClaudeAccountsUsage, type AccountUsageSummary } from '../store/usage-store'
import { useClaudeProfileStore } from '../store/claude-profile-store'
import { useServerSettingsStore, type ServerSettings } from '../store/server-settings-state'
import {
  ensureSessionAccounts,
  sessionAccountView,
  sessionOwnAccount,
  SERVER_USAGE_STALE_MS
} from './session-accounts'
import {
  nextAccountFor,
  resolveSessionAccountRef,
  sessionAccountExhausted,
  sessionAccountUsage,
  sessionSwitchTargets
} from './switch-account'

vi.mock('../store/session-store', () => ({ useSessionStore: {} }))

const week = (used: number, fetchedAt = Date.now()): AccountUsageSummary => {
  const w = {
    key: 'all',
    label: 'Overall',
    kind: 'weekly_all',
    scope: null,
    usedPercentage: used,
    severity: null,
    resetsAt: null
  }
  return { status: 'ready', error: null, windows: [w], tightest: w, fetchedAt }
}

const token = (id: string, label: string): ClaudeAccount => ({
  id,
  label,
  hasToken: true,
  tokenSetAt: null,
  tokenExpiresAt: null,
  tokenInvalid: false
})

const SERVER = 'srv-b'
const serverTab = (accountId: string, label?: string): Session =>
  ({
    id: resourceKey('session', SERVER, 'abc-123'),
    sessionType: 'local',
    claudeMode: true,
    alive: true,
    claudeProfileId: accountId,
    claudeProfileLabel: label
  }) as Session
const localTab = (accountId: string): Session =>
  ({
    id: 'local-1',
    sessionType: 'local',
    claudeMode: true,
    alive: true,
    claudeProfileId: accountId
  }) as Session

function serverEntry(over: Partial<ServerSettings> = {}): ServerSettings {
  return {
    status: 'ready',
    error: null,
    claude: [
      { ...token('default', 'Default'), hasToken: false },
      token('srv-one', '3@example.com'),
      token('srv-two', '4@example.com')
    ],
    codex: [{ id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: false }],
    migrated: [],
    profiles: { customProfiles: [] } as unknown as ServerSettings['profiles'],
    usage: {
      claude: { 'srv-one': week(97), 'srv-two': week(10) },
      codex: {}
    },
    ...over
  }
}

const originalProfiles = useClaudeProfileStore.getState().profiles

afterEach(() => {
  useClaudeProfileStore.setState({ profiles: originalProfiles })
  useClaudeAccountsUsage.setState({ byAccount: {} })
  useServerSettingsStore.setState({ byServer: {} })
  vi.unstubAllGlobals()
})

describe('the accounts of a session come from its owner', () => {
  it('a tab on this Mac reads this Mac’s list and usage', () => {
    useClaudeProfileStore.setState({
      profiles: [...originalProfiles, token('mac-spare', 'Spare')]
    })
    useClaudeAccountsUsage.setState({ byAccount: { default: week(97), 'mac-spare': week(10) } })
    // A server with an account of the same label must not leak in.
    useServerSettingsStore.setState({ byServer: { [SERVER]: serverEntry() } })
    const tab = localTab('default')
    expect(sessionOwnAccount(tab, 'claude')).toMatchObject({
      id: 'default',
      label: 'Default',
      removed: false,
      pending: false,
      auth: 'Machine login'
    })
    expect(sessionAccountExhausted(tab)).toBe(true)
    expect(sessionSwitchTargets(tab).map((t) => t.id)).toEqual(['mac-spare'])
    expect(nextAccountFor(tab)).toBe('mac-spare')
  })

  it('a tab on a server reads that server’s list and usage, never this Mac’s', () => {
    useClaudeProfileStore.setState({
      profiles: [...originalProfiles, token('mac-spare', 'Spare')]
    })
    useClaudeAccountsUsage.setState({ byAccount: { default: week(10), 'mac-spare': week(10) } })
    useServerSettingsStore.setState({ byServer: { [SERVER]: serverEntry() } })
    const tab = serverTab('srv-one', '3@example.com')
    expect(sessionAccountView(tab, 'claude')).toMatchObject({ owner: SERVER, remote: true })
    expect(sessionOwnAccount(tab, 'claude')).toMatchObject({
      id: 'srv-one',
      label: '3@example.com',
      removed: false,
      pending: false,
      auth: 'Token'
    })
    expect(sessionAccountUsage(tab)?.tightest?.usedPercentage).toBe(97)
    expect(sessionAccountExhausted(tab)).toBe(true)
    // The server's other accounts, the Default (its machine login) included.
    const targets = sessionSwitchTargets(tab)
    expect(targets.map((t) => t.id).sort()).toEqual(['default', 'srv-two'])
    expect(targets.find((t) => t.id === 'srv-two')).toMatchObject({
      label: '4@example.com',
      auth: 'Token',
      exhausted: false
    })
    expect(targets.some((t) => t.id === 'mac-spare')).toBe(false)
    expect(nextAccountFor(tab)).not.toBe('mac-spare')
    expect(resolveSessionAccountRef(tab, 'claude', '4@example.com').id).toBe('srv-two')
    expect(() => resolveSessionAccountRef(tab, 'claude', 'Spare')).toThrow(/Unknown Claude/)
  })

  it('a local account names itself live, and a removed one by the label the session kept', () => {
    useClaudeProfileStore.setState({ profiles: [...originalProfiles, token('w1', 'Work')] })
    expect(sessionOwnAccount({ id: 'l', claudeProfileId: 'w1' }, 'claude')).toMatchObject({
      id: 'w1',
      label: 'Work',
      removed: false
    })
    expect(sessionOwnAccount({ id: 'l' }, 'claude')).toMatchObject({
      id: 'default',
      label: 'Default',
      removed: false
    })
    expect(
      sessionOwnAccount({ id: 'l', claudeProfileId: 'gone', claudeProfileLabel: 'Old' }, 'claude')
    ).toMatchObject({ id: 'gone', label: 'Old', removed: true })
    expect(sessionOwnAccount({ id: 'l', claudeProfileId: 'gone' }, 'claude').label).toBe(
      'Removed account'
    )
  })

  it('a server account gone from the server’s list reads removed, with its label', () => {
    useServerSettingsStore.setState({ byServer: { [SERVER]: serverEntry() } })
    expect(sessionOwnAccount(serverTab('srv-gone', 'old@example.com'), 'claude')).toMatchObject({
      label: 'old@example.com',
      removed: true,
      pending: false
    })
  })

  it('a server whose settings are not read yet is pending, never removed, and offers nothing', () => {
    const tab = serverTab('srv-one', '3@example.com')
    expect(sessionOwnAccount(tab, 'claude')).toMatchObject({
      id: 'srv-one',
      label: '3@example.com',
      removed: false,
      pending: true,
      auth: null
    })
    expect(sessionSwitchTargets(tab)).toEqual([])
    expect(nextAccountFor(tab)).toBeNull()
    expect(sessionAccountUsage(tab)).toBeUndefined()
    expect(() => resolveSessionAccountRef(tab, 'claude', 'any')).toThrow(/not read yet/)
    // A first load in flight (the entry holds the Default alone) is still not
    // a known list.
    const empty = serverEntry()
    useServerSettingsStore.setState({
      byServer: {
        [SERVER]: { ...empty, status: 'loading', profiles: null, claude: [empty.claude[0]] }
      }
    })
    expect(sessionOwnAccount(tab, 'claude').pending).toBe(true)
  })
})

describe('ensureSessionAccounts reads what a popover needs', () => {
  const api = (): {
    fleetAccounts: ReturnType<typeof vi.fn>
    fleetUsage: ReturnType<typeof vi.fn>
  } => {
    const electronAPI = {
      fleetAccounts: vi.fn(async () => ({ claude: [], codex: [], migrated: [] })),
      fleetLaunchSettings: vi.fn(async () => ({ profiles: null })),
      fleetUsageSnapshot: vi.fn(async () => ({})),
      fleetUsage: vi.fn(async () => ({ error: 'x' }))
    }
    vi.stubGlobal('window', { electronAPI })
    return electronAPI
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('does nothing for a tab on this Mac', () => {
    const electronAPI = api()
    ensureSessionAccounts(localTab('default'), 'claude')
    expect(electronAPI.fleetAccounts).not.toHaveBeenCalled()
    expect(electronAPI.fleetUsage).not.toHaveBeenCalled()
  })

  it('loads a server never read, and reads a stale account’s usage again', async () => {
    const electronAPI = api()
    ensureSessionAccounts(serverTab('srv-one'), 'claude')
    await vi.waitFor(() => expect(electronAPI.fleetAccounts).toHaveBeenCalled())
    expect(electronAPI.fleetAccounts).toHaveBeenCalledWith(SERVER)
    // The load's own live reads (the Defaults it listed) are not this test's.
    await vi.waitFor(() => expect(electronAPI.fleetUsage).toHaveBeenCalledTimes(2))
    electronAPI.fleetUsage.mockClear()

    const now = Date.now()
    useServerSettingsStore.setState({
      byServer: {
        [SERVER]: serverEntry({
          usage: {
            claude: { 'srv-one': week(10, now - SERVER_USAGE_STALE_MS - 1), 'srv-two': week(10) },
            codex: {}
          }
        })
      }
    })
    ensureSessionAccounts(serverTab('srv-one'), 'claude', now)
    await vi.waitFor(() => expect(electronAPI.fleetUsage).toHaveBeenCalled())
    expect(electronAPI.fleetUsage).toHaveBeenCalledWith(SERVER, 'claude', 'srv-one', false)
    electronAPI.fleetUsage.mockClear()
    // A fresh read is left alone.
    ensureSessionAccounts(serverTab('srv-two'), 'claude', now)
    await settle()
    expect(electronAPI.fleetUsage).not.toHaveBeenCalled()
  })
})
