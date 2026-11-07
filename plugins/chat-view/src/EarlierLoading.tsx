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
