import {
  ArrowsRightLeftIcon,
  ArrowUturnRightIcon,
  CpuChipIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { useSessionStore } from '../../store/session-store'
import type { LimitRung } from '../../store/session-types'
import { effectiveSwitchMode } from '../../store/account-policy-store'
import { acceptRung, dismissAccountProposal } from '../../lib/account-policy'
import { limitOutLabel } from '../../lib/limit-report-words'
import { sessionAccountUsage } from '../../lib/switch-account'
import { capStatus, useClaudeAccountsUsage, useCodexAccountsUsage } from '../../store/usage-store'

/**
 * The way on the policy proposes, in the pane's header (ADR 0002, PRDCT-4302):
 * the cap that is out, named in the readouts' words, then the rungs in
 * order as buttons: `Continue on Opus 5.5` (the same account, another
 * model), `Switch to Play` (another account), `Continue on Codex` (another
 * provider, when that road exists). One click takes the rung; the cross
 * puts the ladder away until it changes. In automatic mode on a working tab
 * the first rung says what is about to happen.
 */
function verbOf(rung: LimitRung, automatic: boolean, primary: boolean): string {
  if (rung.kind === 'account') {
    return automatic && primary ? `Moving to ${rung.label}` : `Switch to ${rung.label}`
  }
  if (rung.kind === 'model' && automatic && primary) return `Continuing on ${rung.label}`
  return `Continue on ${rung.label}`
}

function iconOf(rung: LimitRung): React.JSX.Element {
  if (rung.kind === 'model') return <CpuChipIcon className="w-3 h-3" />
  if (rung.kind === 'provider') return <ArrowUturnRightIcon className="w-3 h-3" />
  return <ArrowsRightLeftIcon className="w-3 h-3" />
}

export function AccountProposal({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const proposal = session?.accountProposal ?? null
  const automatic = session ? effectiveSwitchMode(session) === 'automatic' : false
  // Subscribed so a read that lands while the badge is up renames the cap.
  useClaudeAccountsUsage((s) => s.byAccount)
  useCodexAccountsUsage((s) => s.byAccount)
  if (!session || !proposal || proposal.rungs.length === 0) return null
  // The cap that stops THIS tab, named with its return: from the poll's read
  // of the session's own view, else from the CLI's report.
  const stopping = capStatus(sessionAccountUsage(session))?.stopping ?? null
  const why = limitOutLabel(session.limitReported, stopping)
  const first = proposal.rungs[0]
  const accountRung = proposal.rungs.find((r) => r.kind === 'account')
  const modelRung = proposal.rungs.find((r) => r.kind === 'model')
  const title = automatic
    ? first.kind === 'model'
      ? `${why}. The tab continues on ${first.label}, the same account, as soon as the agent is idle.`
      : `${why}. The tab moves to ${first.label} as soon as the agent is idle.`
    : first.kind === 'model'
      ? `${why}. Continue on ${first.label} on the same account; the conversation carries on.`
      : `${why}. Switch the tab to ${first.label}; the conversation carries on there.`
  return (
    <span
      className="badge flex items-center gap-1 flex-shrink-0 bg-surface-100"
      data-limit-proposal={proposal.reason}
      data-account-proposal={accountRung?.kind === 'account' ? accountRung.accountId : undefined}
      data-model-proposal={modelRung?.kind === 'model' ? modelRung.model : undefined}
      title={title}
    >
      <span className="text-status-waiting">{why}</span>
      {proposal.rungs.map((rung, i) => (
        <button
          key={`${rung.kind}:${rung.label}`}
          className="flex items-center gap-1 text-text-primary hover:underline"
          onClick={() => void acceptRung(sessionId, rung)}
          {...(rung.kind === 'account'
            ? { 'data-account-proposal-accept': rung.accountId }
            : rung.kind === 'model'
              ? { 'data-model-proposal-accept': rung.model }
              : { 'data-provider-proposal-accept': rung.adapterId })}
        >
          {iconOf(rung)}
          {verbOf(rung, automatic, i === 0)}
        </button>
      ))}
      <button
        className="text-text-tertiary hover:text-text-primary"
        onClick={() => dismissAccountProposal(sessionId)}
        aria-label="Dismiss"
        data-account-proposal-dismiss
      >
        <XMarkIcon className="w-3 h-3" />
      </button>
    </span>
  )
}
