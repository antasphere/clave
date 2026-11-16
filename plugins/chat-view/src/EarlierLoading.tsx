import type React from 'react'
import { ArrowPathIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline'

/** Said over the transcript's head while a page of the past is on its way
 *  (`useEarlier`), out of the flow so its coming and going moves no text, and
 *  only once the wait is long enough to notice (`.chat-earlier`'s delay). */
export function EarlierLoading(): React.JSX.Element {
  return (
    <div className="chat-earlier" role="status">
      <ArrowPathIcon />
      Loading earlier messages
    </div>
  )
}

/** Said at the transcript's head when a round of asking for the past found no
 *  answer (`readPast`, PRDCT-3526): the conversation is not empty, its past
 *  did not arrive, and the reader can ask again. In the flow, so it is read
 *  where the past would be. */
export function PastFailed({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <div className="chat-past-failed" role="status">
      <ExclamationCircleIcon />
      <span>Earlier messages could not be loaded</span>
      <button type="button" className="btn-secondary btn-compact" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

/** The host explicitly says its bounded retention dropped older events. */
export function PastTruncated(): React.JSX.Element {
  return (
    <div className="chat-past-failed" role="status">
      <ExclamationCircleIcon />
      <span>Some earlier messages are no longer retained by this server.</span>
    </div>
  )
}

/** Over the transcript's head while another tab's card is being found here
 *  (`useExchangeJump`): reading older history for it, or saying it is not in
 *  this conversation. The same pill as the past on its way, out of the flow. */
export function JumpPill({ status }: { status: 'finding' | 'missing' }): React.JSX.Element {
  return status === 'finding' ? (
    <div className="chat-earlier chat-jump-pill" role="status">
      <ArrowPathIcon />
      Finding the exchange…
    </div>
  ) : (
    <div className="chat-earlier chat-jump-pill" data-tone="missing" role="status">
      <ExclamationCircleIcon />
      That exchange is not in this conversation
    </div>
  )
}
