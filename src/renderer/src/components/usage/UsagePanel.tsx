import { useEffect, useState, type ReactElement } from 'react'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import type { PiUsageTotals, UsageWindow } from '../../../../preload/index.d'
import {
  quotaUsageStores,
  claudeUsageStore,
  piUsageStores,
  useUsageNavigation,
  formatReset
} from '../../store/usage-store'
import {
  useClaudeProfileStore,
  describeClaudeProfileAuth,
  type ClaudeProfile
} from '../../store/claude-profile-store'
import { ClaudeLogo, CodexLogo, AntigravityLogo, PiLogo } from '../icons/cli-logos'
import { ClaudeAccountsSection } from '../settings/ClaudeAccountsSection'

type Tool = 'claude' | 'codex' | 'antigravity' | 'pi'

const TOOLS: { key: Tool; label: string; Logo: (p: { className?: string }) => ReactElement }[] = [
  { key: 'claude', label: 'Claude Code', Logo: ClaudeLogo },
  { key: 'codex', label: 'Codex', Logo: CodexLogo },
  { key: 'antigravity', label: 'Antigravity', Logo: AntigravityLogo },
  { key: 'pi', label: 'Pi', Logo: PiLogo }
]

// Fill color tracks urgency, so a near-full cap reads at a glance. The service sends
// its own plan-aware severity; we take whichever of the two reads more urgent so a
// scoped cap the percentage alone would understate still shows red.
function barLevel(window: UsageWindow): 'normal' | 'warning' | 'critical' {
  const fromPct =
    window.usedPercentage >= 90 ? 'critical' : window.usedPercentage >= 70 ? 'warning' : 'normal'
  const rank = { normal: 0, warning: 1, critical: 2 }
  const own = window.severity ?? 'normal'
  return rank[own] >= rank[fromPct] ? own : fromPct
}

function UsageBar({ window }: { window: UsageWindow }): ReactElement {
  const pct = Math.round(window.usedPercentage)
  const reset = formatReset(window.resetsAt)
  return (
    <div className="space-y-1.5" data-usage-window={window.key}>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-text-primary">{window.label}</span>
        <span
          className="text-[13px] tabular-nums font-semibold text-text-primary"
          aria-label={`${pct}% used`}
        >
          {pct}%
        </span>
      </div>
      <div className="usage-bar">
        <span
          className={`usage-meter-fill usage-meter-fill--${barLevel(window)}`}
          style={{ width: `${Math.min(100, Math.max(window.usedPercentage, pct === 0 ? 0 : 2))}%` }}
        />
      </div>
      {reset && <span className="text-xs text-text-tertiary">{reset}</span>}
    </div>
  )
}

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

/** The windows of one quota read: loading, an error with a retry, or the bars. */
function QuotaWindows({
  resource,
  title
}: {
  resource: ReturnType<typeof claudeUsageStore>
  title?: ReactElement
}): ReactElement {
  const { status, data, error, load, refreshing } = resource()
  const windows = data?.windows ?? []

  useEffect(() => {
    load()
  }, [load])

  const loading = refreshing

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 min-w-0">
        <div className="min-w-0 flex-1">{title}</div>
        <button
          onClick={() => load({ force: true })}
          disabled={loading}
          className="btn-icon btn-icon-md"
          title="Refresh usage"
          aria-label="Refresh usage"
        >
          <ArrowPathIcon className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {(status === 'loading' || status === 'idle') && (
        <div className="space-y-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-1.5">
              <div className="h-4 w-40 animate-pulse rounded bg-surface-200" />
              <div className="h-1.5 w-full animate-pulse rounded-full bg-surface-200" />
            </div>
          ))}
        </div>
      )}

      {status === 'error' && (
        <div className="flex flex-col items-start gap-3 py-2">
          <span className="text-[13px] text-text-tertiary">{error}</span>
          <button onClick={() => load({ force: true })} className="btn-secondary">
            Retry
          </button>
        </div>
      )}

      {status === 'ready' && windows.length === 0 && (
        <span className="text-[13px] text-text-tertiary">
          {data?.message ?? 'No usage limits to show yet.'}
        </span>
      )}

      {status === 'ready' && windows.length > 0 && (
        <div className="space-y-5">
          {windows.map((w) => (
            <UsageBar key={w.key} window={w} />
          ))}
        </div>
      )}
    </div>
  )
}

function CodexUsage(): ReactElement {
  return <QuotaWindows resource={quotaUsageStores.codex} />
}

/** One account's card: its name and how it signs in, then its windows. */
function ClaudeAccountUsage({ account }: { account: ClaudeProfile }): ReactElement {
  return (
    <div className="px-3.5 py-3" data-claude-account-usage={account.id}>
      <QuotaWindows
        resource={claudeUsageStore(account.id)}
        title={
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-medium text-text-primary truncate">
              {account.label}
            </span>
            <span className="badge bg-surface-200 text-text-tertiary flex-shrink-0">
              {describeClaudeProfileAuth(account)}
            </span>
          </div>
        }
      />
    </div>
  )
}

/** Every Claude account, each with its own windows and its name over them,
 *  the accounts section under them. */
function ClaudeUsage(): ReactElement {
  const profiles = useClaudeProfileStore((s) => s.profiles)
  return (
    <>
      <div className="settings-card">
        {profiles.map((account) => (
          <ClaudeAccountUsage key={account.id} account={account} />
        ))}
      </div>
      <ClaudeAccountsSection />
    </>
  )
}

function ComingSoon({ label }: { label: string }): ReactElement {
  return (
    <div className="flex flex-col items-center gap-1.5 py-12 text-center">
      <span className="text-[13px] font-medium text-text-primary">
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
  const { data: totals, status, error, load, refreshing } = piUsageStores[range]()
  useEffect(() => {
    void load()
  }, [load])
  const number = (value: number): string => new Intl.NumberFormat().format(value)
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
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
        <button
          className="btn-icon btn-icon-md"
          title="Refresh usage"
          aria-label="Refresh usage"
          disabled={refreshing}
          onClick={() => load({ force: true })}
        >
          <ArrowPathIcon className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {status === 'error' ? (
        <div className="space-y-3">
          <p className="text-[13px] text-text-tertiary">{error}</p>
          <button className="btn-secondary" onClick={() => load({ force: true })}>
            Retry
          </button>
        </div>
      ) : !totals ? (
        <span className="text-[13px] text-text-tertiary">Reading local Pi sessions…</span>
      ) : (
        <>
          <p className="text-xs text-text-tertiary">
            Local session totals, not account quota. {totals.sessions} session
            {totals.sessions === 1 ? '' : 's'}.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {[
              ['Input', number(totals.input)],
              ['Output', number(totals.output)],
              ['Cache read', number(totals.cacheRead)],
              ['Cache write', number(totals.cacheWrite)],
              ['Total tokens', number(totals.totalTokens)],
              ['Recorded cost', `$${totals.cost.toFixed(4)}`]
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-surface-100 px-3 py-2.5">
                <div className="text-xs text-text-tertiary">{label}</div>
                <div className="text-[13px] tabular-nums text-text-primary">{value}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Usage limits content — embedded in the settings page's Usage section. */
export function UsagePanel(): ReactElement {
  const tool = useUsageNavigation((s) => s.provider) ?? 'claude'
  const setTool = useUsageNavigation((s) => s.select)

  return (
    <div className="space-y-5" data-usage-provider={tool}>
      <ToolToggle tool={tool} onChange={setTool} />
      {tool === 'claude' ? (
        <ClaudeUsage />
      ) : (
        <div className="settings-card">
          <div className="px-3.5 py-3">
            {tool === 'codex' && <CodexUsage />}
            {tool === 'antigravity' && <ComingSoon label="Antigravity" />}
            {tool === 'pi' && <PiUsage />}
          </div>
        </div>
      )}
    </div>
  )
}
