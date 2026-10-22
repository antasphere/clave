import { useLayoutEffect, useState } from 'react'
import type { Conversation } from './reducer'
import { makePresentationSchedule, unfinishedTextOnly } from './presentation-policy'

/** Keep hidden presentation frozen and coalesce unfinished assistant text at
 * a bounded cadence. The caller still reduces every event and reports live
 * metadata. Controls, other entries and completed text never wait for a timer.
 * Revealing uses the current value in that render, without an effect or replay.
 * State, rather than a ref written during render, keeps aborted renders from
 * replacing the snapshot of what the reader actually saw. */
export function usePresentation(value: Conversation, visible: boolean): Conversation {
  const [presented, setPresented] = useState(() => value)
  const [wasVisible, setWasVisible] = useState(visible)
  const [schedule] = useState(() => makePresentationSchedule<Conversation>(setPresented))
  const immediate = visible && (!wasVisible || !unfinishedTextOnly(presented, value))
  if (wasVisible !== visible) setWasVisible(visible)
  if (immediate && presented !== value) setPresented(value)
  useLayoutEffect(() => {
    if (!visible) schedule.cancel()
    else if (immediate || presented === value) schedule.commit(value)
    else schedule.offer(value)
  }, [value, visible, immediate, presented, schedule])
  useLayoutEffect(() => () => schedule.cancel(), [schedule])
  return immediate ? value : presented
}
