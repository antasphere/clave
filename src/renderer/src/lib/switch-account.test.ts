import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../store/session-types'
import {
  useClaudeAccountsUsage,
  useCodexAccountsUsage,
  type AccountUsageSummary
} from '../store/usage-store'
import { useClaudeProfileStore } from '../store/claude-profile-store'
import {
  sessionAccountExhausted,
  sessionAccountUsage,
  sessionSwitchTargets,
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
