import { useState } from 'react'

/** Keep the last presented snapshot while hidden. The caller still reduces
 * every event and reports live metadata; only transcript presentation waits.
 * Revealing uses the current value in that render, without an effect or replay.
 * State, rather than a ref written during render, keeps aborted renders from
 * replacing the snapshot of what the reader actually saw. */
export function usePresentation<T>(value: T, visible: boolean): T {
  const [presented, setPresented] = useState(() => value)
  if (visible && presented !== value) setPresented(() => value)
  return visible ? value : presented
}
