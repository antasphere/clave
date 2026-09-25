import type React from 'react'
import { ArrowPathIcon } from '@heroicons/react/24/outline'

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
