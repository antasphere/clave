import {
  applyConversationEvent,
  type ConversationAPI,
  type ConversationEnvelope,
  type ConversationSnapshot
} from '../../../shared/agent-session'

/** Subscribe before fetching so events racing the snapshot cannot be lost. */
export function subscribeConversation(
  api: ConversationAPI,
  sessionId: string,
  update: (snapshot: ConversationSnapshot) => void,
  failed: (error: Error) => void
): () => void {
  let disposed = false
  let fetching = false
  let snapshot: ConversationSnapshot | undefined
  let pending: ConversationEnvelope[] = []
  const report = (error: unknown): void =>
    failed(error instanceof Error ? error : new Error(String(error)))
  const drain = (recoverGap = true): void => {
    if (!snapshot || fetching || disposed) return
    pending.sort((a, b) => a.sequence - b.sequence)
    pending = pending.filter((event) => event.sequence > snapshot!.sequence)
    while (pending.length) {
      if (pending[0].sequence <= snapshot.sequence) {
        pending.shift()
        continue
      }
      if (pending[0].sequence !== snapshot.sequence + 1) {
        if (recoverGap) void refresh()
        return
      }
      snapshot = applyConversationEvent(snapshot, pending.shift()!)
    }
    update(snapshot)
  }
  const refresh = async (): Promise<void> => {
    if (fetching || disposed) return
    fetching = true
    const previousSequence = snapshot?.sequence
    try {
      const next = await api.snapshot(sessionId)
      if (disposed) return
      if (!snapshot || next.sequence >= snapshot.sequence) {
        snapshot = next
        update(next)
      }
    } catch (error) {
      if (!disposed) report(error)
    } finally {
      fetching = false
    }
    // A stale/unavailable snapshot must not trigger a tight retry loop.
    if (!disposed && snapshot) drain(snapshot.sequence !== previousSequence)
  }
  const unsubscribe = api.onEvent((event) => {
    if (event.sessionId !== sessionId || disposed) return
    pending.push(event)
    drain()
  })
  // Covers a disconnected service that restarts without emitting another event.
  const timer = setInterval(() => void refresh(), 5000)
  void refresh()
  return () => {
    disposed = true
    unsubscribe()
    clearInterval(timer)
  }
}
