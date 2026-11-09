import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../store/session-types'
import {
  useClaudeAccountsUsage,
  useCodexAccountsUsage,
  type AccountUsageSummary
} from '../store/usage-store'
import {
  useAccountPolicyStore,
  loadAccountPolicy,
  subscribeAccountLaunchPolicy
} from '../store/account-policy-store'
import { useCodexAccountStore } from '../store/codex-account-store'
import { useClaudeProfileStore } from '../store/claude-profile-store'
import {
  sessionAccountExhausted,
  sessionAccountUsage,
  sessionSwitchTargets,
  accountForLaunch,
  nextAccountFor,
  resolveAccountRef
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

  it('still applies shared exhaustion to Claude, and the family rule to Codex’s model buckets', () => {
    const shared = { ...windows[0], usedPercentage: 99 }
    useClaudeAccountsUsage.setState({
      byAccount: { default: { ...summary, windows: [shared, windows[1]] } }
    })
    expect(sessionAccountExhausted(session('opus'))).toBe(true)
    // Codex: Spark's own block is a family cap; a session on another model
    // is judged on the shared week alone, one on Spark on both.
    const week = { ...windows[0], key: 'week', usedPercentage: 30 }
    const spark = {
      ...windows[1],
      key: 'spark',
      kind: 'session',
      scope: 'Spark',
      label: 'Spark 5h'
    }
    useCodexAccountsUsage.setState({
      byAccount: { default: { ...summary, windows: [week, spark], tightest: week } }
    })
    const codex = { ...session('gpt-5.3-codex'), claudeMode: false, codexMode: true }
    expect(sessionAccountUsage(codex)?.windows).toEqual([week])
    expect(sessionAccountExhausted(codex)).toBe(false)
    const onSpark = { ...codex, model: 'gpt-5.3-codex-spark' }
    expect(sessionAccountUsage(onSpark)?.tightest?.key).toBe('spark')
    expect(sessionAccountExhausted(onSpark)).toBe(true)
  })
})

describe('the launch picks its account for the model it will run', () => {
  afterEach(() => {
    useClaudeProfileStore.setState({ selectedProfileId: 'default' })
  })
  it('lands a launch on Opus on an account whose Fable cap is out, and skips it for Fable', () => {
    const spare = { ...originalProfiles[0], id: 'spare', label: 'Spare', hasToken: true }
    useClaudeProfileStore.setState({
      profiles: [...originalProfiles, spare],
      selectedProfileId: 'default'
    })
    // The selected account: its Fable week spent, 75% of its week left.
    // The spare: open everywhere.
    const open = { ...windows[0], usedPercentage: 10 }
    useClaudeAccountsUsage.setState({
      byAccount: {
        default: summary,
        spare: { status: 'ready', error: null, windows: [open], tightest: open }
      }
    })
    expect(accountForLaunch('claude', undefined, 'claude-opus-5-5').id).toBe('default')
    expect(accountForLaunch('claude', undefined, 'claude-fable-5-1').id).toBe('spare')
    // No model: the shared caps alone decide, and they have room.
    expect(accountForLaunch('claude').id).toBe('default')
    // A named account is an instruction, whatever its caps.
    expect(accountForLaunch('claude', 'default', 'claude-fable-5-1').id).toBe('default')
    // The agent road: "any" (and no account) resolves through the same pick
    // for the same model.
    expect(resolveAccountRef('claude', 'any', 'claude-fable-5-1').id).toBe('spare')
    expect(resolveAccountRef('claude', undefined, 'claude-fable-5-1').id).toBe('spare')
    expect(resolveAccountRef('claude', 'any', 'claude-opus-5-5').id).toBe('default')
  })
  it('moves a tab to the open account with the most of its week left, not the next in the ring', () => {
    const second = { ...originalProfiles[0], id: 'second', label: 'Second', hasToken: true }
    const third = { ...originalProfiles[0], id: 'third', label: 'Third', hasToken: true }
    useClaudeProfileStore.setState({ profiles: [...originalProfiles, second, third] })
    const week = (used: number): AccountUsageSummary => {
      const w = { ...windows[0], usedPercentage: used }
      return { status: 'ready', error: null, windows: [w], tightest: w }
    }
    // Leaving default: the ring says Second next, but Third has far more week.
    useClaudeAccountsUsage.setState({
      byAccount: { default: week(97), second: week(80), third: week(10) }
    })
    expect(nextAccountFor(session('opus'))).toBe('third')
  })
  it('judges a Codex launch and a Codex move for the model too: Spark’s bucket is a family', () => {
    useCodexAccountStore.setState({
      accounts: [
        { id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: true },
        { id: 'spare', label: 'Spare', kind: 'chatgpt', hasCredential: true }
      ],
      selectedAccountId: 'default'
    })
    const week = { ...windows[0], key: 'week', usedPercentage: 30 }
    const spark = {
      ...windows[1],
      key: 'spark',
      kind: 'session',
      scope: 'Spark',
      label: 'Spark 5h'
    }
    const open = { ...windows[0], key: 'open', usedPercentage: 10 }
    useCodexAccountsUsage.setState({
      byAccount: {
        default: { status: 'ready', error: null, windows: [week, spark], tightest: week },
        spare: { status: 'ready', error: null, windows: [open], tightest: open }
      }
    })
    expect(accountForLaunch('codex', undefined, 'gpt-5.3-codex-spark').id).toBe('spare')
    expect(accountForLaunch('codex', undefined, 'gpt-5.3-codex').id).toBe('default')
    expect(accountForLaunch('codex').id).toBe('default')
    const onSpark = {
      ...session('gpt-5.3-codex-spark'),
      claudeMode: false,
      codexMode: true,
      codexAccountId: 'default'
    }
    expect(nextAccountFor(onSpark)).toBe('spare')
    expect(sessionSwitchTargets(onSpark).find((t) => t.id === 'spare')?.suggested).toBe(true)
    useCodexAccountStore.setState({
      accounts: [{ id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: true }],
      selectedAccountId: 'default'
    })
  })
  it('skips an account whose SHARED cap is out for every model', () => {
    const spare = { ...originalProfiles[0], id: 'spare', label: 'Spare', hasToken: true }
    useClaudeProfileStore.setState({
      profiles: [...originalProfiles, spare],
      selectedProfileId: 'default'
    })
    const spent = { ...windows[0], usedPercentage: 97 }
    const open = { ...windows[0], usedPercentage: 10 }
    useClaudeAccountsUsage.setState({
      byAccount: {
        default: { status: 'ready', error: null, windows: [spent], tightest: spent },
        spare: { status: 'ready', error: null, windows: [open], tightest: open }
      }
    })
    expect(accountForLaunch('claude', undefined, 'claude-opus-5-5').id).toBe('spare')
    expect(accountForLaunch('claude').id).toBe('spare')
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
    const launch = (id?: string): { id: string } =>
      provider === 'claude' ? accountForLaunch('claude', id) : accountForLaunch('codex', id)
    expect(launch().id).toBe('default')
    useAccountPolicyStore.setState({ useRecommendedAccount: true })
    expect(launch().id).toBe('spare')
    expect(launch('default').id).toBe('default')
    useAccountPolicyStore.setState({ useRecommendedAccount: false })
    expect(launch().id).toBe('default')
  })
  it('updates an already-open window and releases its listener', () => {
    let notify: (enabled: boolean) => void = () => {}
    const unsubscribe = vi.fn()
    vi.stubGlobal('window', {
      electronAPI: {
        onRecommendedAccountChanged: (callback: typeof notify) => {
          notify = callback
          return unsubscribe
        }
      }
    })
    const stop = subscribeAccountLaunchPolicy()
    notify(true)
    expect(useAccountPolicyStore.getState().useRecommendedAccount).toBe(true)
    notify(false)
    expect(useAccountPolicyStore.getState().useRecommendedAccount).toBe(false)
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
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
