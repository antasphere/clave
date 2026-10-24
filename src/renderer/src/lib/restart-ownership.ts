/** Correlate the answer and push of one operation, never the next restart
 * of the same session. Pending calls do not expire. Completed answers whose
 * push was lost keep at most 128 receipts; only their exact IDs can suppress
 * an event. Older evicted receipts are treated as external events. */
export const MAX_COMPLETED_RESTARTS = 128
interface Mark {
  sessionId: string
  applied: boolean
  settled: boolean
}
const marks = new Map<string, Mark>()
export function beginOwnRestart(sessionId: string, requestId: string): void {
  marks.set(requestId, { sessionId, applied: false, settled: false })
}
export function abandonOwnRestart(requestId: string): void {
  marks.delete(requestId)
}
export function ownAnswerApplies(
  sessionId: string,
  requestId: string,
  echoedRequestId?: string
): boolean {
  const mark = marks.get(requestId)
  // IPC, or an older server that does not echo correlation: no matching
  // server push is promised. Never suppress a subsequent unrelated restart.
  if (echoedRequestId !== requestId) {
    marks.delete(requestId)
    return true
  }
  if (!mark || mark.sessionId !== sessionId) return true
  if (mark.applied) {
    marks.delete(requestId)
    return false
  }
  mark.applied = true
  mark.settled = true
  // Retain by completion order, including a slow call begun before newer calls.
  marks.delete(requestId)
  marks.set(requestId, mark)
  const completed = [...marks].filter(([, entry]) => entry.settled)
  for (const [id] of completed.slice(0, Math.max(0, completed.length - MAX_COMPLETED_RESTARTS)))
    marks.delete(id)
  return true
}
export function servedRestartApplies(sessionId: string, requestId?: string): boolean {
  if (!requestId) return true
  const mark = marks.get(requestId)
  if (!mark || mark.sessionId !== sessionId) return true
  if (mark.applied) {
    marks.delete(requestId)
    return false
  }
  mark.applied = true
  return true
}
export function resetOwnRestarts(): void {
  marks.clear()
}
