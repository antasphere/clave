/**
 * The chat style picked in the first-run walk, until a chat session carries
 * it to the process that opens sessions. On a packaged Mac that is the
 * separate server, which learns the default view only from a session's
 * `setView` (`sessions/host.ts`, `rememberChatView`); a reader who skipped
 * connecting an assistant has no session yet, so the pick waits here and the
 * first chat launched anywhere delivers it (`launch-session.ts`).
 */
const KEY = 'clave.onboarding.pending-chat-view'

export function setPendingChatView(viewId: string | null): void {
  try {
    if (viewId) localStorage.setItem(KEY, viewId)
    else localStorage.removeItem(KEY)
  } catch {
    /* no store: the shell's own preference still holds the pick */
  }
}

export function pendingChatView(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** Deliver the waiting pick through a freshly launched session, once: only a
 *  chat session (the events transport) has a view to set. */
export async function deliverPendingChatView(
  sessionId: string,
  api: {
    sessionsList: () => Promise<{ id: string; transport?: string }[]>
    sessionsSetView: (id: string, viewId: string | null) => Promise<unknown>
  }
): Promise<boolean> {
  const viewId = pendingChatView()
  if (!viewId) return false
  const session = (await api.sessionsList().catch(() => [])).find((s) => s.id === sessionId)
  if (session?.transport !== 'events') return false
  try {
    await api.sessionsSetView(sessionId, viewId)
  } catch {
    return false
  }
  setPendingChatView(null)
  return true
}
