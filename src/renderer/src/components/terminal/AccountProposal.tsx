import { ArrowsRightLeftIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useSessionStore } from '../../store/session-store'
import { effectiveSwitchMode } from '../../store/account-policy-store'
import { acceptAccountProposal, dismissAccountProposal } from '../../lib/account-policy'

/**
 * The move the policy proposes, in the pane's header (ADR 0002): the account
 * is about to hit its limit, here is where the tab would go. One click
 * makes the move; the cross puts it away until the account changes. In
 * automatic mode on a working tab it says the move is coming.
 */
export function AccountProposal({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const proposal = useSessionStore(
    (s) => s.sessions.find((session) => session.id === sessionId)?.accountProposal ?? null
  )
  const automatic = useSessionStore((s) => {
    const session = s.sessions.find((x) => x.id === sessionId)
    return session ? effectiveSwitchMode(session) === 'automatic' : false
  })
  if (!proposal) return null
  const why = proposal.reason === 'reported' ? 'Limit reached' : 'At limit'
  return (
    <span
      className="badge flex items-center gap-1 flex-shrink-0 bg-surface-100"
      data-account-proposal={proposal.accountId}
      title={
        automatic
          ? `This account is at its limit. The tab moves to ${proposal.label} as soon as the agent is idle.`
          : `This account is at its limit. Switch the tab to ${proposal.label}; the conversation carries on there.`
      }
    >
      <span className="text-status-waiting">{why}</span>
      <button
        className="flex items-center gap-1 text-text-primary hover:underline"
        onClick={() => void acceptAccountProposal(sessionId)}
        data-account-proposal-accept
      >
        <ArrowsRightLeftIcon className="w-3 h-3" />
        {automatic ? `Moving to ${proposal.label}` : `Switch to ${proposal.label}`}
      </button>
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
