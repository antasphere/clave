import { useState } from 'react'
import { ArrowsRightLeftIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type { ProviderSwitchPlan } from '../../../src/preload/index.d'
import type { ProviderPick } from './ModelMenu'

/* The popover a provider switch opens before anything moves (PRDCT-4300),
   in the dock above the composer where the host's own panels open. Its
   words are the person's: the move RECONSTRUCTS the conversation on the
   other provider, it does not continue it; what carries, what does not,
   where it lands, and which road it takes, said before Continue. Nothing
   restarts until Continue. */

export interface ProviderSwitchLanding {
  account: { id: string; label: string } | null
  headroom: string | null
}

export function ProviderSwitch({
  from,
  target,
  plan,
  landing,
  noteOffered,
  noteAgent,
  working = false,
  busy,
  error,
  onContinue,
  onClose
}: {
  /** The provider the tab is on, as the reader names it (Claude). */
  from: string
  target: ProviderPick
  /** The road the host announced; null while it is being asked. */
  plan: ProviderSwitchPlan | null
  landing: ProviderSwitchLanding
  /** Whether the current agent can still write a handoff note (its account has room). */
  noteOffered: boolean
  /** The current model's name, for the note's checkbox ("Have Opus 5.5 write…"). */
  noteAgent: string
  /** The agent is working now: Continue cuts its turn, said here. */
  working?: boolean
  /** What the move is doing now, or null when it waits on Continue. */
  busy: string | null
  error: string | null
  onContinue: (options: { note: boolean }) => void
  onClose: () => void
}): React.JSX.Element {
  const [note, setNote] = useState(false)
  const to = target.label
  const lands = [to, landing.account?.label, landing.headroom, target.model.label]
    .filter(Boolean)
    .join(' · ')
  return (
    <section
      className="chat-prompt chat-provider-switch"
      data-kind="provider-switch"
      data-road={plan?.road}
      aria-label={`Move this conversation to ${to}`}
    >
      <div className="chat-prompt-head">
        <ArrowsRightLeftIcon className="chat-tool-status" />
        <span className="chat-prompt-title">Move this conversation to {to}</span>
        <button
          type="button"
          className="chat-turn-copy"
          aria-label="Cancel the move"
          title="Cancel"
          onClick={onClose}
          disabled={busy !== null}
        >
          <XMarkIcon />
        </button>
      </div>
      <p className="chat-prompt-detail">
        This <strong>reconstructs</strong> the conversation on {to}. It does not continue it: {to}{' '}
        reads what was said and done, then takes over.
      </p>
      <dl className="chat-provider-switch-facts">
        <dt>What carries</dt>
        <dd>The conversation, the tool runs as history, the files on disk.</dd>
        <dt>What does not</dt>
        <dd>
          {from}&apos;s working memory, the approvals you granted, and the live results of its
          earlier tool runs, which {to} reads as another agent&apos;s.
        </dd>
        <dt>Where it lands</dt>
        <dd>{lands}</dd>
        <dt>How</dt>
        <dd>
          {plan === null
            ? 'Checking what can be converted…'
            : plan.road === 'convert'
              ? `Converted into a ${to} conversation (Codex ${plan.codexVersion}) and opened there with its history. If ${to} refuses the converted conversation, it goes as a handoff message instead.`
              : `As a handoff message that opens the new conversation: the transcript, the files ${from} changed, and where the full tape is. ${plan.reason}`}
        </dd>
      </dl>
      {noteOffered && (
        <label className="chat-provider-switch-note">
          <input
            type="checkbox"
            checked={note}
            disabled={busy !== null}
            onChange={(event) => setNote(event.currentTarget.checked)}
          />
          <span>
            Have {noteAgent} write a handoff note first, as one more turn here; it goes with the
            conversation, as its last words.
          </span>
        </label>
      )}
      {working && (
        <p className="chat-prompt-detail chat-provider-switch-working">
          {from} is working now: Continue stops its turn where it is.
        </p>
      )}
      {error && (
        <p className="chat-prompt-detail chat-provider-switch-error" role="alert">
          {error}
        </p>
      )}
      <div className="chat-prompt-actions">
        <button
          type="button"
          className="chat-prompt-btn"
          data-kind="primary"
          disabled={busy !== null || plan === null}
          onClick={() => onContinue({ note })}
        >
          {busy ?? 'Continue'}
        </button>
        <button
          type="button"
          className="chat-prompt-btn"
          disabled={busy !== null}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </section>
  )
}

/** The card at the head of a conversation that came from another provider
 *  (PRDCT-4300): "Continued from Claude · converted". */
export function ContinuedFromCard({
  from,
  road
}: {
  from: string
  road: 'converted' | 'handoff'
}): React.JSX.Element {
  return (
    <div className="chat-continued-from" role="note" data-road={road}>
      Continued from {from} · {road}
    </div>
  )
}
