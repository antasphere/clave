import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../store/session-types'
import {
  useClaudeAccountsUsage,
  useCodexAccountsUsage,
  type AccountUsageSummary
} from '../store/usage-store'
import { useAccountPolicyStore, loadAccountPolicy } from '../store/account-policy-store'
import { useCodexAccountStore } from '../store/codex-account-store'
import { useClaudeProfileStore } from '../store/claude-profile-store'
import {
  sessionAccountExhausted,
  sessionAccountUsage,
  sessionSwitchTargets,
  accountForLaunch,
  nextAccountFor
} from './switch-account'

vi.mock('../store/session-store', () => ({ useSessionStore: {} }))

const windows = [
  {
    key: 'all',
    label: 'Overall',
    kind: 'weekly_all',
    scope: null,
    usedPercentage: 25,
    severity: null,
    resetsAt: null
  },
  {
    key: 'fable',
    label: 'Fable',
    kind: 'weekly_scoped',
    scope: 'Fable',
    usedPercentage: 100,
    severity: 'critical' as const,
    resetsAt: null
  }
]
const summary: AccountUsageSummary = { status: 'ready', error: null, windows, tightest: windows[1] }
const session = (model?: string): Session =>
  ({ sessionType: 'local', claudeMode: true, model, claudeProfileId: 'default' }) as Session
const originalProfiles = useClaudeProfileStore.getState().profiles

afterEach(() => {
  useClaudeAccountsUsage.setState({ byAccount: {} })
  useCodexAccountsUsage.setState({ byAccount: {} })
  useClaudeProfileStore.setState({ profiles: originalProfiles })
})

describe('session account quota', () => {
  it('uses model context for the exhaustion flag shared by MCP and account policy', () => {
    useClaudeAccountsUsage.setState({ byAccount: { default: summary } })
    expect(sessionAccountExhausted(session('opus'))).toBe(false)
    expect(sessionAccountExhausted(session('sonnet'))).toBe(false)
    expect(sessionAccountExhausted(session())).toBe(false)
    expect(sessionAccountExhausted(session('claude-fable-5'))).toBe(true)
    expect(sessionAccountUsage(session('opus'))?.tightest?.key).toBe('all')
    expect(useClaudeAccountsUsage.getState().byAccount.default).toBe(summary)
  })

  it('keeps an account with exhausted Fable quota available to an Opus switch', () => {
    const spare = { ...originalProfiles[0], id: 'spare', label: 'Spare', hasToken: true }
    useClaudeProfileStore.setState({ profiles: [...originalProfiles, spare] })
    useClaudeAccountsUsage.setState({ byAccount: { spare: summary } })
    const target = sessionSwitchTargets(session('opus')).find((t) => t.id === 'spare')
    expect(target?.exhausted).toBe(false)
    expect(target?.suggested).toBe(true)
    expect(target?.summary?.tightest?.key).toBe('all')
    expect(nextAccountFor(session('opus'))).toBe('spare')
    expect(sessionSwitchTargets(session('fable')).find((t) => t.id === 'spare')?.exhausted).toBe(
      true
    )
  })

  it('still applies shared exhaustion to Claude and leaves Codex quotas intact', () => {
    const shared = { ...windows[0], usedPercentage: 99 }
    useClaudeAccountsUsage.setState({
      byAccount: { default: { ...summary, windows: [shared, windows[1]] } }
    })
    expect(sessionAccountExhausted(session('opus'))).toBe(true)
    useCodexAccountsUsage.setState({ byAccount: { default: summary } })
    expect(sessionAccountUsage({ ...session('opus'), claudeMode: false, codexMode: true })).toBe(
      summary
    )
  })
})

describe('recommended account setting', () => {
  afterEach(() => {
    useAccountPolicyStore.setState({ useRecommendedAccount: false })
    useClaudeProfileStore.setState({ selectedProfileId: 'default' })
    useCodexAccountStore.setState({
      accounts: [{ id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: true }],
      selectedAccountId: 'default'
    })
    vi.unstubAllGlobals()
  })
  it.each(['claude', 'codex'] as const)('applies only to implicit %s launches', (provider) => {
    useClaudeProfileStore.setState({
      profiles: [
        ...originalProfiles,
        { ...originalProfiles[0], id: 'spare', label: 'Spare', hasToken: true }
      ]
    })
    useCodexAccountStore.setState({
      accounts: [
        { id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: true },
        { id: 'spare', label: 'Spare', kind: 'chatgpt', hasCredential: true }
      ]
    })
    const window = { ...windows[0], resetsAt: 1000 }
    const usage = {
      default: { ...summary, windows: [{ ...window, resetsAt: 5000 }], tightest: window },
      spare: { ...summary, windows: [window], tightest: window }
    }
    useClaudeAccountsUsage.setState({ byAccount: usage })
    useCodexAccountsUsage.setState({ byAccount: usage })
    const launch = (id?: string) =>
      provider === 'claude' ? accountForLaunch('claude', id) : accountForLaunch('codex', id)
    expect(launch().id).toBe('default')
    useAccountPolicyStore.setState({ useRecommendedAccount: true })
    expect(launch().id).toBe('spare')
    expect(launch('default').id).toBe('default')
    useAccountPolicyStore.setState({ useRecommendedAccount: false })
    expect(launch().id).toBe('default')
  })
  it('loads the persisted opt-in and rejects non-boolean values', async () => {
    const get = vi.fn(async () => true)
    const set = vi.fn(async () => {})
    vi.stubGlobal('window', { electronAPI: { preferencesGet: get, preferencesSet: set } })
    await loadAccountPolicy()
    expect(useAccountPolicyStore.getState().useRecommendedAccount).toBe(true)
    useAccountPolicyStore.getState().setUseRecommendedAccount(false)
    expect(set).toHaveBeenCalledWith('useRecommendedAccount', false)
    get.mockResolvedValue('true' as unknown as boolean)
    await loadAccountPolicy()
    expect(useAccountPolicyStore.getState().useRecommendedAccount).toBe(false)
  })
})
