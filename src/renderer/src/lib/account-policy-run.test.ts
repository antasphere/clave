import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../store/session-types'
import type { AccountUsageSummary } from '../store/usage-store'

/**
 * The policy at work (ADR 0002, PRDCT-4302), the wiring the pure rule does
 * not see (round 1, G1): the scope resolved from the report and the read,
 * the model rung read off the ACCOUNT's view and offered to chats only, the
 * `set_model` written with `remember: false`, the report stored on arrival
 * with the forced read, the proposal taken down once a rung is taken, and
 * the hold while the provider has not confirmed the switch.
 */
const fake = vi.hoisted(() => ({
  sessions: [] as Partial<Session>[],
  proposals: [] as [string, unknown][],
  reports: [] as [string, unknown][],
  writes: [] as [string, unknown][],
  reads: [] as [string, unknown][],
  mode: 'propose' as 'propose' | 'automatic',
  onFamilyLimit: 'switch-model' as 'switch-model' | 'switch-account',
  exhausted: false,
  next: 'play' as string | null,
  /** The account's read, every family under `scoped`. */
  account: undefined as AccountUsageSummary | undefined,
  /** The session's view of it. */
  view: undefined as AccountUsageSummary | undefined,
  switched: [] as [string, string, unknown][],
  limitListener: null as null | ((payload: { id: string; report: unknown }) => void),
  noopStore: { subscribe: () => () => {}, getState: () => ({}) }
}))
vi.mock('./fleet-identity', () => ({ isRemoteKey: () => false }))
vi.mock('../store/session-store', () => ({
  useSessionStore: {
    getState: () => ({
      sessions: fake.sessions,
      setAccountProposal: (id: string, p: unknown) => {
        fake.proposals.push([id, p])
        const s = fake.sessions.find((x) => x.id === id)
        if (s) s.accountProposal = p as Session['accountProposal']
      },
      setLimitReported: (id: string, r: unknown) => {
        fake.reports.push([id, r])
        const s = fake.sessions.find((x) => x.id === id)
        if (s) s.limitReported = r as Session['limitReported']
      }
    }),
    subscribe: () => () => {}
  }
}))
vi.mock('../store/usage-store', () => ({
  accountsUsageFor: () => ({ work: fake.account }),
  useClaudeAccountsUsage: fake.noopStore,
  useCodexAccountsUsage: fake.noopStore
}))
vi.mock('../store/claude-profile-store', () => ({
  useClaudeProfileStore: fake.noopStore,
  getClaudeProfile: (id: string) => ({ id, label: id === 'play' ? 'Play' : 'Work' })
}))
vi.mock('../store/codex-account-store', () => ({
  useCodexAccountStore: fake.noopStore,
  getCodexAccount: (id: string) => ({ id, label: id })
}))
vi.mock('../store/account-policy-store', () => ({
  useAccountPolicyStore: fake.noopStore,
  effectiveSwitchMode: () => fake.mode,
  effectiveFamilyLimitRule: () => fake.onFamilyLimit
}))
vi.mock('./switch-account', () => ({
  accountProviderOf: (s: Session) => (s.claudeMode ? 'claude' : s.codexMode ? 'codex' : null),
  nextAccountFor: () => fake.next,
  sessionAccountExhausted: () => fake.exhausted,
  sessionAccountId: () => 'work',
  sessionAccountUsage: () => fake.view,
  switchSessionAccount: async (id: string, account: string, options: unknown) => {
    fake.switched.push([id, account, options])
    return { ok: true, resumed: true }
  }
}))
import { acceptRung, runAccountPolicy, startAccountPolicy } from './account-policy'

const w = (over: Record<string, unknown>): Record<string, unknown> => ({
  key: 'k',
  label: 'l',
  kind: 'weekly_all',
  scope: null,
  usedPercentage: 40,
  severity: 'normal',
  resetsAt: 1_000,
  ...over
})
const week = w({})
const fableOut = w({
  kind: 'weekly_scoped',
  scope: 'Fable',
  usedPercentage: 100,
  severity: 'critical'
})
const accountView = (...out: string[]): AccountUsageSummary =>
  ({
    status: 'ready',
    error: null,
    tightest: week,
    shared: week,
    windows: [week],
    scoped: ['Fable', 'Opus', 'Sonnet'].map((family) => ({
      family,
      window: w({
        kind: 'weekly_scoped',
        scope: family,
        usedPercentage: out.includes(family) ? 100 : 20
      }),
      exhausted: out.includes(family)
    }))
  }) as unknown as AccountUsageSummary
const fableView = (): AccountUsageSummary =>
  ({
    status: 'ready',
    error: null,
    tightest: fableOut,
    shared: week,
    windows: [week, fableOut]
  }) as unknown as AccountUsageSummary
let n = 0
/** A fresh id per case: the policy keeps a move in flight per session across runs. */
const chat = (over: Partial<Session> = {}): Partial<Session> => ({
  id: `s${++n}`,
  alive: true,
  sessionType: 'local',
  claudeMode: true,
  launchProfileId: 'claude-chat',
  model: 'claude-fable-5-1',
  activityStatus: 'idle',
  agentState: 'idle',
  claudeProfileId: 'work',
  ...over
})
const lastProposal = (): unknown => fake.proposals[fake.proposals.length - 1]?.[1]
const lastReport = (): unknown => fake.reports[fake.reports.length - 1]
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const idOf = (): string => fake.sessions[0].id as string

beforeEach(() => {
  fake.sessions = []
  fake.proposals = []
  fake.reports = []
  fake.writes = []
  fake.reads = []
  fake.switched = []
  fake.mode = 'propose'
  fake.onFamilyLimit = 'switch-model'
  fake.exhausted = false
  fake.next = 'play'
  fake.account = accountView('Fable')
  fake.view = fableView()
  vi.stubGlobal('window', {
    electronAPI: {
      sessionsWrite: async (id: string, input: unknown) => {
        fake.writes.push([id, input])
      },
      getUsageLimits: async (id: string, o: unknown) => {
        fake.reads.push([id, o])
      },
      getCodexUsageLimits: async () => {},
      onSessionLimitReported: (cb: (payload: { id: string; report: unknown }) => void) => {
        fake.limitListener = cb
        return () => {}
      }
    }
  })
})

describe('runAccountPolicy', () => {
  it("a family's cap on a chat: the model rung first, labelled, then the account", () => {
    fake.sessions = [chat({ limitReported: { scope: 'shared' } })]
    runAccountPolicy()
    expect(lastProposal()).toEqual({
      reason: 'reported',
      rungs: [
        { kind: 'model', model: 'claude-opus-5-5', label: 'Opus 5.5' },
        { kind: 'account', accountId: 'play', label: 'Play' }
      ]
    })
    expect(fake.writes).toEqual([])
  })

  it('a terminal tab is offered the account rung alone: it takes no set_model (round 1, W1)', () => {
    fake.sessions = [
      chat({ launchProfileId: 'claude-work', limitReported: { scope: { family: 'Fable' } } })
    ]
    runAccountPolicy()
    expect(lastProposal()).toEqual({
      reason: 'reported',
      rungs: [{ kind: 'account', accountId: 'play', label: 'Play' }]
    })
    fake.sessions = [
      chat({ launchProfileId: undefined, limitReported: { scope: { family: 'Fable' } } })
    ]
    runAccountPolicy()
    expect(lastProposal()).toEqual({
      reason: 'reported',
      rungs: [{ kind: 'account', accountId: 'play', label: 'Play' }]
    })
  })

  it("the model rung reads the ACCOUNT's view, not the session's (round 1, W3)", () => {
    // The session's view drops the other families; the account's says Opus is out too.
    fake.account = accountView('Fable', 'Opus')
    fake.sessions = [chat({ limitReported: { scope: { family: 'Fable' } } })]
    runAccountPolicy()
    expect(lastProposal()).toEqual({
      reason: 'reported',
      rungs: [
        { kind: 'model', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
        { kind: 'account', accountId: 'play', label: 'Play' }
      ]
    })
  })

  it('the poll alone, the family cap out on the view: the same ladder, reason limit', () => {
    fake.exhausted = true
    fake.sessions = [chat()]
    runAccountPolicy()
    expect(lastProposal()).toEqual({
      reason: 'limit',
      rungs: [
        { kind: 'model', model: 'claude-opus-5-5', label: 'Opus 5.5' },
        { kind: 'account', accountId: 'play', label: 'Play' }
      ]
    })
  })

  it('automatic mode writes set_model once, not remembered, keeps the report until the provider confirms, and holds meanwhile (round 1, W2, F3, F4)', async () => {
    fake.mode = 'automatic'
    fake.sessions = [chat()]
    startAccountPolicy()
    fake.limitListener!({ id: idOf(), report: { scope: 'shared' } })
    runAccountPolicy()
    await flush()
    expect(fake.writes).toEqual([
      [idOf(), { type: 'set_model', model: 'claude-opus-5-5', remember: false }]
    ])
    // The report stays open until the model change lands (integration round 1, F4).
    expect(fake.sessions[0].limitReported).toEqual({ scope: 'shared' })
    expect(lastProposal()).toBeNull()
    // The store still shows Fable and the view still reads out: the policy
    // runs again and writes nothing more.
    fake.exhausted = true
    runAccountPolicy()
    await Promise.resolve()
    expect(fake.writes).toHaveLength(1)
    expect(lastProposal()).toBeNull()
    // The provider confirmed: the store shows Opus, the report closes, nothing proposed.
    fake.sessions[0].model = 'claude-opus-5-5'
    fake.exhausted = false
    runAccountPolicy()
    expect(fake.writes).toHaveLength(1)
    expect(lastReport()).toEqual([idOf(), null])
    expect(lastProposal()).toBeNull()
  })

  it('a write the host refuses releases the tab at once: the ladder is offered again (round 2, F4e)', async () => {
    fake.mode = 'automatic'
    fake.sessions = [chat({ limitReported: { scope: { family: 'Fable' } } })]
    ;(window.electronAPI as { sessionsWrite: unknown }).sessionsWrite = async () => {
      throw new Error('refused')
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    runAccountPolicy()
    await flush()
    error.mockRestore()
    // The report stays open (nothing was switched); the ladder is offered again at once.
    fake.exhausted = true
    fake.mode = 'propose'
    runAccountPolicy()
    expect(lastProposal()).toEqual({
      reason: 'reported',
      rungs: [
        { kind: 'model', model: 'claude-opus-5-5', label: 'Opus 5.5' },
        { kind: 'account', accountId: 'play', label: 'Play' }
      ]
    })
  })

  it('automatic mode on the account setting restarts on the next account and resends', async () => {
    fake.mode = 'automatic'
    fake.onFamilyLimit = 'switch-account'
    fake.sessions = [chat({ limitReported: { scope: { family: 'Fable' } } })]
    runAccountPolicy()
    await flush()
    expect(fake.switched).toEqual([[idOf(), 'play', { resendRejected: true }]])
    expect(fake.writes).toEqual([])
  })

  it('a shared cap takes the account rung whatever the setting', () => {
    fake.view = {
      ...fableView(),
      tightest: w({ usedPercentage: 100, severity: 'critical' }),
      shared: w({ usedPercentage: 100, severity: 'critical' })
    } as unknown as AccountUsageSummary
    fake.sessions = [chat({ limitReported: { scope: 'shared' } })]
    runAccountPolicy()
    expect(lastProposal()).toEqual({
      reason: 'reported',
      rungs: [{ kind: 'account', accountId: 'play', label: 'Play' }]
    })
  })
})

describe('the report closes with the model change, stays open on a refusal (integration round 1, F3, F4)', () => {
  const arrive = (report: unknown): void => {
    startAccountPolicy()
    fake.limitListener!({ id: idOf(), report })
  }

  it('a model switch made from the chip closes the report and the card, and nothing moves', () => {
    fake.sessions = [chat()]
    arrive({ scope: { family: 'Fable' } })
    runAccountPolicy()
    expect(lastProposal()).toMatchObject({ reason: 'reported' })
    // The person picked Opus from the chip: the store learns the model from the push.
    fake.sessions[0].model = 'claude-opus-5-5'
    fake.mode = 'automatic'
    runAccountPolicy()
    expect(lastReport()).toEqual([idOf(), null])
    expect(lastProposal()).toBeNull()
    expect(fake.writes).toEqual([])
    expect(fake.switched).toEqual([])
    // The same model pushed again changes nothing.
    runAccountPolicy()
    expect(fake.writes).toEqual([])
  })

  it("the policy's own model rung keeps the report until the provider confirms, then closes it", async () => {
    fake.mode = 'automatic'
    fake.sessions = [chat()]
    arrive({ scope: { family: 'Fable' } })
    runAccountPolicy()
    await flush()
    expect(fake.writes).toHaveLength(1)
    expect(lastProposal()).toBeNull()
    // The write resolved; the report is still open on the tab.
    expect(fake.sessions[0].limitReported).toEqual({ scope: { family: 'Fable' } })
    fake.sessions[0].model = 'claude-opus-5-5'
    runAccountPolicy()
    expect(lastReport()).toEqual([idOf(), null])
    expect(fake.switched).toEqual([])
  })

  it('a refused model rung falls to the account rung once its window closes, the rejected message still resent', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      fake.mode = 'automatic'
      fake.sessions = [chat()]
      arrive({ scope: { family: 'Fable' } })
      runAccountPolicy()
      await vi.runAllTimersAsync()
      expect(fake.writes).toHaveLength(1)
      // Nothing confirmed: the store still shows Fable, the report is open,
      // the policy holds while the window is open.
      fake.exhausted = true
      runAccountPolicy()
      expect(fake.writes).toHaveLength(1)
      expect(fake.switched).toEqual([])
      vi.setSystemTime(1_000_000 + 16_000)
      runAccountPolicy()
      await vi.runAllTimersAsync()
      // The refused model is not offered again; the account rung carries the message.
      expect(fake.writes).toHaveLength(1)
      expect(fake.switched).toEqual([[idOf(), 'play', { resendRejected: true }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('in propose mode the ladder after a refusal offers the account alone, reason reported', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(2_000_000)
      fake.sessions = [chat()]
      arrive({ scope: { family: 'Fable' } })
      runAccountPolicy()
      await acceptRung(idOf(), { kind: 'model', model: 'claude-opus-5-5', label: 'Opus 5.5' })
      expect(fake.writes).toHaveLength(1)
      expect(lastProposal()).toBeNull()
      fake.exhausted = true
      vi.setSystemTime(2_000_000 + 16_000)
      runAccountPolicy()
      expect(lastProposal()).toEqual({
        reason: 'reported',
        rungs: [{ kind: 'account', accountId: 'play', label: 'Play' }]
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a Codex tab (integration round 1, F6, G4)', () => {
  it("a Spark bucket's cap offers the account rung alone: the model table is Claude's", () => {
    fake.account = {
      ...accountView(),
      scoped: [
        { family: 'Spark', window: w({ scope: 'Spark', usedPercentage: 100 }), exhausted: true }
      ]
    } as unknown as AccountUsageSummary
    fake.sessions = [
      chat({
        claudeMode: false,
        codexMode: true,
        launchProfileId: 'codex-chat',
        model: 'gpt-5.5-spark'
      })
    ]
    startAccountPolicy()
    fake.limitListener!({ id: idOf(), report: { scope: { family: 'Spark' } } })
    runAccountPolicy()
    expect(lastProposal()).toEqual({
      reason: 'reported',
      rungs: [{ kind: 'account', accountId: 'play', label: 'play' }]
    })
    expect(fake.writes).toEqual([])
    // Even a family the Claude table knows, named on a Codex tab, offers no Claude model.
    fake.sessions = [chat({ claudeMode: false, codexMode: true, launchProfileId: 'codex-chat' })]
    fake.limitListener!({ id: idOf(), report: { scope: { family: 'Fable' } } })
    runAccountPolicy()
    expect(lastProposal()).toEqual({
      reason: 'reported',
      rungs: [{ kind: 'account', accountId: 'play', label: 'play' }]
    })
  })
})

describe('acceptRung', () => {
  it('the model rung writes set_model, not remembered, settles the proposal, and the report closes with the model change (round 1, W4)', async () => {
    fake.sessions = [
      chat({
        accountProposal: {
          reason: 'reported',
          rungs: [{ kind: 'model', model: 'claude-opus-5-5', label: 'Opus 5.5' }]
        }
      })
    ]
    startAccountPolicy()
    fake.limitListener!({ id: idOf(), report: { scope: { family: 'Fable' } } })
    await acceptRung(idOf(), { kind: 'model', model: 'claude-opus-5-5', label: 'Opus 5.5' })
    expect(fake.writes).toEqual([
      [idOf(), { type: 'set_model', model: 'claude-opus-5-5', remember: false }]
    ])
    expect(lastProposal()).toBeNull()
    expect(fake.sessions[0].limitReported).toEqual({ scope: { family: 'Fable' } })
    // The card the person clicked does not come back while the switch is in flight.
    fake.exhausted = true
    runAccountPolicy()
    expect(lastProposal()).toBeNull()
    // The provider confirmed: the report closes.
    fake.sessions[0].model = 'claude-opus-5-5'
    runAccountPolicy()
    expect(lastReport()).toEqual([idOf(), null])
  })

  it('the account rung restarts the tab on that account, resending when the CLI reported', async () => {
    fake.sessions = [
      chat({
        limitReported: { scope: 'credits' },
        accountProposal: {
          reason: 'reported',
          rungs: [{ kind: 'account', accountId: 'play', label: 'Play' }]
        }
      })
    ]
    await acceptRung(idOf(), { kind: 'account', accountId: 'play', label: 'Play' })
    expect(fake.switched).toEqual([[idOf(), 'play', { resendRejected: true }]])
    expect(fake.writes).toEqual([])
  })

  it('does nothing on a tab with no proposal', async () => {
    fake.sessions = [chat()]
    await acceptRung(idOf(), { kind: 'model', model: 'claude-opus-5-5', label: 'Opus 5.5' })
    expect(fake.writes).toEqual([])
  })
})

describe('startAccountPolicy', () => {
  it('stores the report as it arrives and forces a read of the account (round 1, W5)', () => {
    fake.sessions = [chat()]
    startAccountPolicy()
    expect(fake.limitListener).not.toBeNull()
    fake.limitListener!({ id: idOf(), report: { scope: 'shared', resetsAt: 5 } })
    expect(fake.reports).toEqual([[idOf(), { scope: 'shared', resetsAt: 5 }]])
    expect(fake.reads).toEqual([['work', { force: true }]])
    // A report for a tab this window does not hold is dropped.
    fake.limitListener!({ id: 'nope', report: { scope: 'shared' } })
    expect(fake.reports).toHaveLength(1)
  })
})
