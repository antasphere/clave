import { useEffect, useState, type ReactElement } from 'react'
import { ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import type { PiUsageTotals, UsageWindow, CodexAccount } from '../../../../preload/index.d'
import {
  codexUsageStore,
  claudeUsageStore,
  piUsageStores,
  useUsageNavigation,
  useClaudeAccountsUsage,
  useCodexAccountsUsage,
  refreshAllUsage,
  tightestWindow,
  isWeeklyWindow,
  formatResetAt,
  formatResetIn,
  formatAge,
  capLevel,
  columnLabel,
  type AccountUsageSummary
} from '../../store/usage-store'
import {
  useClaudeProfileStore,
  describeClaudeProfileAuth,
  type ClaudeProfile
} from '../../store/claude-profile-store'
import { ClaudeLogo, CodexLogo, AntigravityLogo, PiLogo } from '../icons/cli-logos'
import { useCodexAccountStore, describeCodexAccountAuth } from '../../store/codex-account-store'
import { SettingsCallout, SettingsRow, SettingsSection } from '../settings/primitives'
import { UsageColumn } from './UsageColumn'
import { useNow } from '../../lib/use-now'

type Tool = 'claude' | 'codex' | 'antigravity' | 'pi'

const TOOLS: { key: Tool; label: string; Logo: (p: { className?: string }) => ReactElement }[] = [
  { key: 'claude', label: 'Claude Code', Logo: ClaudeLogo },
  { key: 'codex', label: 'Codex', Logo: CodexLogo },
  { key: 'antigravity', label: 'Antigravity', Logo: AntigravityLogo },
  { key: 'pi', label: 'Pi', Logo: PiLogo }
]

/** The provider switch: the side panel's tab bar, at page width. */
function ToolToggle({ tool, onChange }: { tool: Tool; onChange: (t: Tool) => void }): ReactElement {
  return (
    <div className="launcher-panel">
      <div className="launcher-row">
        {TOOLS.map(({ key, label, Logo }, index) => {
          const active = key === tool
          return (
            <div key={key} className="contents">
              {index > 0 && <span className="launcher-sep" />}
              <button
                onClick={() => onChange(key)}
                className="panel-tab flex-1 justify-center"
                data-selected={active ? 'true' : undefined}
                aria-pressed={active}
              >
                <Logo className="w-3.5 h-3.5 flex-shrink-0" />
                {label}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── The quota overview ──────────────────────────────────────────────────────
//
// One page per provider, read top to bottom in the order the questions get
// asked: which weekly limit resets next and which one is closest to running
// out (two tiles), how every account's weekly caps compare (the main chart),
// and the 5-hour session block (a second, smaller chart). The accounts sit in
// the same order in both charts: the soonest weekly reset first.

type QuotaProvider = 'claude' | 'codex'

/** One account as the overview needs it: who it is and what its read says. */
interface AccountRead {
  id: string
  label: string
  auth: string
  summary: AccountUsageSummary | undefined
}

function windowsOf(account: AccountRead): UsageWindow[] {
  return account.summary?.status === 'error' ? [] : (account.summary?.windows ?? [])
}

/** The weekly caps (and anything longer than a session the service invents);
 *  the 5-hour session block is `sessionOf`. */
function weeklyOf(account: AccountRead): UsageWindow[] {
  return windowsOf(account).filter((w) => w.kind !== 'session')
}
function sessionOf(account: AccountRead): UsageWindow[] {
  return windowsOf(account).filter((w) => w.kind === 'session')
}

/** The soonest reset among an account's weekly caps, or Infinity. */
function nextWeeklyReset(account: AccountRead): number {
  const resets = weeklyOf(account)
    .filter(isWeeklyWindow)
    .map((w) => w.resetsAt)
    .filter((at): at is number => at != null)
  return resets.length > 0 ? Math.min(...resets) : Number.POSITIVE_INFINITY
}

/** The accounts in the order both charts draw them: the next weekly reset
 *  first, an account that could not be read last, the Accounts page's order
 *  breaking ties. */
function orderAccounts(accounts: AccountRead[]): AccountRead[] {
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((a, b) => {
      const failedA = a.account.summary?.status === 'error' ? 1 : 0
      const failedB = b.account.summary?.status === 'error' ? 1 : 0
      if (failedA !== failedB) return failedA - failedB
      const resetA = nextWeeklyReset(a.account)
      const resetB = nextWeeklyReset(b.account)
      if (resetA !== resetB) return resetA < resetB ? -1 : 1
      return a.index - b.index
    })
    .map(({ account }) => account)
}

/** One account's group in a chart: its columns, then its name under them. */
function AccountGroup({
  provider,
  account,
  windows,
  now,
  primary
}: {
  provider: QuotaProvider
  account: AccountRead
  windows: UsageWindow[]
  now: number
  /** The weekly chart: the group that stands for the account in the tests
   *  and carries its credential. */
  primary: boolean
}): ReactElement {
  const status = account.summary?.status ?? 'idle'
  const accountAttr = primary
    ? provider === 'claude'
      ? { 'data-claude-account-usage': account.id }
      : { 'data-codex-account-usage': account.id }
    : {}
  const soonest = windows
    .filter(isWeeklyWindow)
    .map((w) => w.resetsAt)
    .filter((at): at is number => at != null)
  const resetAt = primary && soonest.length > 0 ? formatResetAt(Math.min(...soonest)) : null
  return (
    <div className="usage-chart-group" data-usage-account={account.id} {...accountAttr}>
      <div className="usage-chart-columns">
        {windows.length > 0 ? (
          windows.map((w) => <UsageColumn key={w.key} window={w} now={now} />)
        ) : status === 'loading' || status === 'idle' ? (
          <span className="usage-column-placeholder animate-pulse" aria-label="Reading usage" />
        ) : (
          <span className="usage-chart-empty">
            {status === 'error'
              ? 'Could not be read'
              : primary
                ? (account.summary?.message ?? 'No limits reported')
                : 'No session limit'}
          </span>
        )}
      </div>
      <div className="usage-chart-caption">
        <span className="usage-chart-account" title={account.label}>
          {account.label}
        </span>
        {primary && account.auth !== account.label && (
          <span className="usage-chart-meta">{account.auth}</span>
        )}
        {resetAt && <span className="usage-chart-meta">Resets {resetAt}</span>}
      </div>
    </div>
  )
}

/** A chart: one group per account, every column on the same 0–100% scale,
 *  so a glance across the row compares every account's caps. */
function UsageChart({
  provider,
  accounts,
  pick,
  primary,
  kind,
  now
}: {
  provider: QuotaProvider
  accounts: AccountRead[]
  pick: (account: AccountRead) => UsageWindow[]
  primary: boolean
  kind: 'weekly' | 'session'
  now: number
}): ReactElement {
  return (
    <div className="settings-card usage-chart" data-usage-chart={kind}>
      <div className="usage-chart-plot">
        {accounts.map((account) => (
          <AccountGroup
            key={account.id}
            provider={provider}
            account={account}
            windows={pick(account)}
            now={now}
            primary={primary}
          />
        ))}
      </div>
    </div>
  )
}

/** A headline number: the question it answers, the answer, whose it is. */
function StatTile({
  label,
  value,
  detail,
  level,
  full = false
}: {
  label: string
  value: string
  detail: string
  level?: 'normal' | 'warning' | 'critical'
  /** At its limit already: the value says so, the warning icon would repeat it. */
  full?: boolean
}): ReactElement {
  return (
    <div className="settings-card" data-level={level}>
      {/* One child, so the card's row seams never cut the tile. */}
      <div className="usage-tile">
        <span className="usage-tile-label">{label}</span>
        <span className="usage-tile-value">
          {level === 'critical' && !full && <ExclamationTriangleIcon aria-hidden />}
          {value}
        </span>
        <span className="usage-tile-detail">{detail}</span>
      </div>
    </div>
  )
}

/** The two questions first: which weekly limit resets next, and which cap
 *  is closest to stopping you. */
function QuotaHeadlines({ accounts, now }: { accounts: AccountRead[]; now: number }): ReactElement {
  const weekly = accounts.flatMap((account) =>
    weeklyOf(account)
      .filter(isWeeklyWindow)
      .map((w) => ({ account, w }))
  )
  const next = weekly
    .filter(({ w }) => w.resetsAt != null)
    .sort((a, b) => (a.w.resetsAt ?? 0) - (b.w.resetsAt ?? 0))[0]
  const every = accounts.flatMap((account) => windowsOf(account).map((w) => ({ account, w })))
  const closest = every.sort((a, b) => {
    const tight = tightestWindow([a.w, b.w])
    return tight === a.w ? -1 : tight === b.w ? 1 : 0
  })[0]
  return (
    <div className="usage-tiles" data-usage-headlines>
      <StatTile
        label="Next weekly reset"
        value={next ? (formatResetIn(next.w.resetsAt, now) ?? '—') : '—'}
        detail={
          next
            ? `${next.account.label} · ${columnLabel(next.w)} · ${formatResetAt(next.w.resetsAt)}`
            : 'No weekly limit read yet'
        }
      />
      <StatTile
        label="Closest to its limit"
        value={closest ? `${Math.round(closest.w.usedPercentage)}% used` : '—'}
        level={closest ? capLevel(closest.w) : undefined}
        full={!!closest && closest.w.usedPercentage >= 100}
        detail={
          closest
            ? `${closest.account.label} · ${closest.w.label}${
                closest.w.resetsAt != null
                  ? ` · resets ${formatResetIn(closest.w.resetsAt, now)}`
                  : ''
              }`
            : 'No limit read yet'
        }
      />
    </div>
  )
}

/** A provider's whole overview: the headlines, the weekly chart, the session
 *  chart, then whatever could not be read, each with its reason. */
function QuotaOverview({
  provider,
  accounts: listed,
  onRetry
}: {
  provider: QuotaProvider
  accounts: { id: string; label: string; auth: string }[]
  onRetry: () => void
}): ReactElement {
  const byAccount = (provider === 'claude' ? useClaudeAccountsUsage : useCodexAccountsUsage)(
    (s) => s.byAccount
  )
  const now = useNow()

  // Every account's store exists and has been asked once: the cache when it
  // is fresh, a read when it is not. Never forced — that is the Refresh.
  const ids = listed.map((a) => a.id).join('|')
  useEffect(() => {
    for (const { id } of listed) {
      const store = provider === 'claude' ? claudeUsageStore(id) : codexUsageStore(id)
      void store.getState().load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id list
  }, [provider, ids])

  const accounts = orderAccounts(listed.map((a) => ({ ...a, summary: byAccount[a.id] })))
  const failed = accounts.filter((a) => a.summary?.status === 'error')
  const anySession = accounts.some((a) => sessionOf(a).length > 0)

  return (
    <div className="space-y-8">
      <QuotaHeadlines accounts={accounts} now={now} />
      <SettingsSection
        title="Weekly limits"
        description="The caps that decide your week, per account. Soonest reset first."
      >
        <UsageChart
          provider={provider}
          accounts={accounts}
          pick={weeklyOf}
          primary
          kind="weekly"
          now={now}
        />
      </SettingsSection>
      {anySession && (
        <SettingsSection
          title="5-hour session"
          description="The rolling block that refills every five hours."
        >
          <UsageChart
            provider={provider}
            accounts={accounts}
            pick={sessionOf}
            primary={false}
            kind="session"
            now={now}
          />
        </SettingsSection>
      )}
      {failed.length > 0 && (
        <div className="space-y-2" data-usage-errors>
          {failed.map((account) => (
            <SettingsCallout
              key={account.id}
              tone="danger"
              title={account.label}
              text={account.summary?.error ?? 'Usage could not be read.'}
              actions={
                <button className="btn-secondary" onClick={onRetry}>
                  Retry
                </button>
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** The Claude accounts, in the Accounts page's order. */
function useClaudeAccountList(): { id: string; label: string; auth: string }[] {
  const profiles = useClaudeProfileStore((s) => s.profiles)
  return profiles.map((p: ClaudeProfile) => ({
    id: p.id,
    label: p.label,
    auth: describeClaudeProfileAuth(p)
  }))
}

function useCodexAccountList(): { id: string; label: string; auth: string }[] {
  const accounts = useCodexAccountStore((s) => s.accounts)
  return accounts.map((a: CodexAccount) => ({
    id: a.id,
    label: a.label,
    auth: describeCodexAccountAuth(a)
  }))
}

/** The page's one Refresh, in its header: every account of the provider on
 *  screen read live, and whatever else has already been read (another
 *  provider's accounts, the Pi ranges) with it. A provider never looked at is
 *  not started for it — a Codex read is a process. Beside it, how old the
 *  numbers on screen are, so a refresh is seen to have happened. */
export function UsageRefresh(): ReactElement {
  const tool = useUsageNavigation((s) => s.provider) ?? 'claude'
  const claude = useClaudeProfileStore((s) => s.profiles)
  const codex = useCodexAccountStore((s) => s.accounts)
  const claudeUsage = useClaudeAccountsUsage((s) => s.byAccount)
  const codexUsage = useCodexAccountsUsage((s) => s.byAccount)
  const [busy, setBusy] = useState(false)
  const now = useNow(15_000)

  const seen = (usage: Record<string, AccountUsageSummary>, id: string): boolean =>
    usage[id] != null && usage[id].status !== 'idle'
  const refresh = (): void => {
    setBusy(true)
    void refreshAllUsage(
      claude.map((p) => p.id).filter((id) => tool === 'claude' || seen(claudeUsage, id)),
      codex.map((a) => a.id).filter((id) => tool === 'codex' || seen(codexUsage, id))
    ).finally(() => setBusy(false))
  }

  const visible =
    tool === 'claude'
      ? claude.map((p) => claudeUsage[p.id])
      : tool === 'codex'
        ? codex.map((a) => codexUsage[a.id])
        : []
  const reads = visible
    .map((s) => s?.fetchedAt)
    .filter((at): at is number => typeof at === 'number')
  const spinning = busy || visible.some((s) => s?.refreshing)
  const age = reads.length > 0 ? formatAge(Math.min(...reads), now) : null

  return (
    <div className="flex items-center gap-2" data-usage-refresh>
      {age && (
        <span className="text-xs text-text-tertiary tabular-nums" data-usage-age>
          {spinning ? 'Reading…' : `Updated ${age}`}
        </span>
      )}
      <button
        onClick={refresh}
        disabled={spinning}
        className="btn-secondary"
        aria-label="Refresh usage"
        title="Read every account again now"
      >
        <ArrowPathIcon className={`w-3.5 h-3.5 ${spinning ? 'animate-spin' : ''}`} />
        Refresh
      </button>
    </div>
  )
}

function ComingSoon({ label }: { label: string }): ReactElement {
  return (
    <div className="flex flex-col items-center gap-1.5 py-12 text-center">
      <span className="text-control font-medium text-text-primary">
        {label} usage isn’t available yet
      </span>
      <span className="text-xs text-text-tertiary">
        We’re working on bringing usage limits to {label}.
      </span>
    </div>
  )
}

function PiUsage(): ReactElement {
  const [range, setRange] = useState<PiUsageTotals['range']>('today')
  const { data: totals, status, error, load } = piUsageStores[range]()
  useEffect(() => {
    void load()
  }, [load])
  const number = (value: number): string => new Intl.NumberFormat().format(value)
  return (
    <>
      <div className="settings-row">
        <div className="segmented">
          {(
            [
              ['today', 'Today'],
              ['7d', '7d'],
              ['30d', '30d'],
              ['all', 'All']
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className="segmented-item"
              data-active={range === id ? 'true' : undefined}
              onClick={() => setRange(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {status === 'error' ? (
        <SettingsCallout
          inset
          tone="danger"
          text={error}
          actions={
            <button className="btn-secondary" onClick={() => load({ force: true })}>
              Retry
            </button>
          }
        />
      ) : !totals ? (
        <SettingsRow label="Reading local Pi sessions…" />
      ) : (
        <>
          <SettingsRow label="Sessions" description="Local session totals, not account quota.">
            <span className="settings-row-value">{number(totals.sessions)}</span>
          </SettingsRow>
          {[
            ['Input', number(totals.input)],
            ['Output', number(totals.output)],
            ['Cache read', number(totals.cacheRead)],
            ['Cache write', number(totals.cacheWrite)],
            ['Total tokens', number(totals.totalTokens)],
            ['Recorded cost', `$${totals.cost.toFixed(4)}`]
          ].map(([label, value]) => (
            <SettingsRow key={label} label={label}>
              <span className="settings-row-value">{value}</span>
            </SettingsRow>
          ))}
        </>
      )}
    </>
  )
}

/** Usage limits content — embedded in the settings page's Usage section. */
export function UsagePanel(): ReactElement {
  const tool = useUsageNavigation((s) => s.provider) ?? 'claude'
  const setTool = useUsageNavigation((s) => s.select)
  const claude = useClaudeAccountList()
  const codex = useCodexAccountList()
  const retry = (provider: QuotaProvider): void => {
    void refreshAllUsage(
      provider === 'claude' ? claude.map((a) => a.id) : [],
      provider === 'codex' ? codex.map((a) => a.id) : []
    )
  }

  return (
    <div className="space-y-6" data-usage-provider={tool}>
      <ToolToggle tool={tool} onChange={setTool} />
      {tool === 'claude' ? (
        <QuotaOverview provider="claude" accounts={claude} onRetry={() => retry('claude')} />
      ) : tool === 'codex' ? (
        <QuotaOverview provider="codex" accounts={codex} onRetry={() => retry('codex')} />
      ) : (
        <div className="settings-card">
          {tool === 'pi' ? (
            <PiUsage />
          ) : (
            <div className="px-3.5 py-3">
              {tool === 'antigravity' && <ComingSoon label="Antigravity" />}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
